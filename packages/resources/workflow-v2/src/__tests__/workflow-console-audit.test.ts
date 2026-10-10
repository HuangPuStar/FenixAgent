// 控制面审计接入（3C）的行为契约：创建 / 改名 / 删除三条控制面动作的审计流水。
//
// 审计用真实 `workflow_v2_audit_log` 表断言（只追加、不更新删除）：每行必须能回答「谁、对哪个 workflow、
// 做了什么、结果如何」。夹具（数据库句柄、守卫与上游替身）在 `helpers/console-plane-harness.ts`。
//
// 发布动作的审计（`workflow.publish`）不再有新写入方：控制台发布入口已于 2026-10-10 撤除（发布在上游侧完成），
// 历史行由「发布日志」弹窗读取；版本号自增的用例见 `workflow-publish-version.test.ts`。

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createWebWorkflowV2WorkflowRoutes } from "../server/routes/web/workflows";
import type { UpstreamCallResult } from "../server/services/upstream-client";
import { softDeleteWorkflow } from "../server/services/workflow-registry";
import {
  cleanupTestRows,
  closeTestPool,
  createStubAuthGuard,
  createUpstreamStub,
  databaseReachable,
  installDatabase,
  jsonInit,
  ORG_A,
  OWNER_ID,
  readAuditRows,
  readRawRow,
  request,
  seedBinding,
  seedRecord,
  upstreamFail,
  upstreamId,
  upstreamOk,
} from "./helpers/console-plane-harness";

type Responses = Record<string, () => UpstreamCallResult | Promise<UpstreamCallResult>>;

/** 把控制面 CRUD 子路由装到一个应用上：审计用例共用守卫与上游替身，避免两套替身漂移。 */
function createConsolePlaneApp(
  guard: ReturnType<typeof createStubAuthGuard>,
  upstream: ReturnType<typeof createUpstreamStub>,
) {
  return new Elysia().use(
    createWebWorkflowV2WorkflowRoutes({ authGuardPlugin: guard.plugin }, { callUpstream: upstream.call }),
  );
}

describe.skipIf(!databaseReachable)("控制面审计接入（真实 Postgres + 上游替身）", () => {
  const guard = createStubAuthGuard();
  let responses: Responses;
  let upstream: ReturnType<typeof createUpstreamStub>;
  let app: Elysia;

  beforeEach(async () => {
    installDatabase();
    await seedBinding();
    responses = {};
    upstream = createUpstreamStub(responses);
    app = createConsolePlaneApp(guard, upstream);
    guard.setActor({ organizationId: ORG_A, userId: OWNER_ID });
  });

  afterAll(() => {
    guard.setActor(null);
  });

  // 创建成功要留下「谁建的、哪个上游对象」的凭据：这是审计表最基础的用途（跨系统身份建立的唯一记录）。
  test("创建成功记 workflow.create/ok", async () => {
    responses["/api/workflow_api/create"] = () => upstreamOk({ data: { workflow_id: upstreamId("audit-created") } });

    await request(app, "/workflows", jsonInit("POST", { name: "审计创建" }));

    expect(await readAuditRows(ORG_A, "workflow.create")).toContainEqual({
      upstreamWorkflowId: upstreamId("audit-created"),
      result: "ok",
      errorCode: null,
      actorUserId: OWNER_ID,
      requestId: null,
    });
  });

  // 上游拒绝创建也要留痕：此时上游没有对象、本地没有行，失败事实只能靠审计回答（排查「为什么建不出来」）。
  test("创建被上游拒绝记 upstream_rejected", async () => {
    responses["/api/workflow_api/create"] = () => upstreamFail(400, "name is required");

    await request(app, "/workflows", jsonInit("POST", { name: "审计拒绝" }));

    const rows = await readAuditRows(ORG_A, "workflow.create");
    expect(rows.map((row) => [row.result, row.errorCode])).toContainEqual(["upstream_rejected", "UPSTREAM_REJECTED"]);
  });

  // 改名是「上游已生效 + 本地镜像」的两步动作：审计要记在成功之后，作为上游变更的本地凭据。
  test("改名成功记 workflow.update_meta/ok", async () => {
    const record = await seedRecord("audit-rename");
    responses["/api/workflow_api/update_meta"] = () => upstreamOk({});

    await request(app, `/workflows/${record.id}`, jsonInit("PATCH", { name: "审计改名后" }));

    expect(await readAuditRows(ORG_A, "workflow.update_meta")).toContainEqual({
      upstreamWorkflowId: record.upstreamWorkflowId,
      result: "ok",
      errorCode: null,
      actorUserId: OWNER_ID,
      requestId: null,
    });
  });

  // 上游策略拒绝删除（首发审核中/需先下架）时本地不软删：审计必须留下「请求过、被拒」的记录，
  // 否则事后无法解释「为什么上游还有这个对象、本地却以为删过了」。
  test("删除被策略拒绝记 strategy_rejected 且不软删", async () => {
    const record = await seedRecord("audit-strategy");
    responses["/api/workflow_api/delete_strategy"] = () => upstreamOk({ data: 2 });

    await request(app, `/workflows/${record.id}`, { method: "DELETE" });

    expect(await readAuditRows(ORG_A, "workflow.delete")).toContainEqual({
      upstreamWorkflowId: record.upstreamWorkflowId,
      result: "strategy_rejected",
      errorCode: null,
      actorUserId: OWNER_ID,
      requestId: null,
    });
    expect((await readRawRow(record.upstreamWorkflowId))?.syncState).toBe("active");
    expect(upstream.calls.map((item) => item.path)).toEqual(["/api/workflow_api/delete_strategy"]);
  });

  // 真正删除分两条流水：`workflow.delete` 记本地软删（pending_delete，对账任务的输入），
  // `workflow.delete.upstream` 记上游结果——两段事实分开，才不会把「本地已删、上游还在」记成一次成功。
  test("删除落 pending_delete 并另记上游结果", async () => {
    const record = await seedRecord("audit-delete");
    responses["/api/workflow_api/delete_strategy"] = () => upstreamOk({ data: 0 });
    responses["/api/workflow_api/delete"] = () => upstreamOk({ data: { status: 0 } });

    await request(app, `/workflows/${record.id}`, { method: "DELETE" });

    expect(await readAuditRows(ORG_A, "workflow.delete")).toContainEqual({
      upstreamWorkflowId: record.upstreamWorkflowId,
      result: "pending_delete",
      errorCode: null,
      actorUserId: OWNER_ID,
      requestId: null,
    });
    expect((await readAuditRows(ORG_A, "workflow.delete.upstream")).map((row) => row.result)).toContain("ok");
  });

  // 上游删除失败（本地已软删）是最需要对账的场景：审计要明确记成 upstream_rejected 而不是 ok，
  // 且本地状态保持 pending_delete（不因上游失败改判）。
  test("上游删除被拒记 upstream_rejected 且本地保持待删", async () => {
    const record = await seedRecord("audit-delete-rejected");
    responses["/api/workflow_api/delete_strategy"] = () => upstreamOk({ data: 0 });
    // `delete` 用 `data.status` 表达结果（0=成功），非 0 即上游拒绝（契约快照 §3 F8）。
    responses["/api/workflow_api/delete"] = () => upstreamOk({ data: { status: 1 } });

    await request(app, `/workflows/${record.id}`, { method: "DELETE" });

    expect(await readAuditRows(ORG_A, "workflow.delete.upstream")).toContainEqual({
      upstreamWorkflowId: record.upstreamWorkflowId,
      result: "upstream_rejected",
      errorCode: "UPSTREAM_REJECTED",
      actorUserId: OWNER_ID,
      requestId: null,
    });
    expect((await readRawRow(record.upstreamWorkflowId))?.syncState).toBe("pending_delete");
  });

  // 审计表是只追加流水：后续动作不得改写既有行（同一 workflow 的创建行必须原样保留）。
  test("审计流水只追加、不更新既有行", async () => {
    responses["/api/workflow_api/create"] = () => upstreamOk({ data: { workflow_id: upstreamId("audit-append") } });
    await request(app, "/workflows", jsonInit("POST", { name: "只追加" }));
    const created = await readAuditRows(ORG_A, "workflow.create");

    responses["/api/workflow_api/delete_strategy"] = () => upstreamOk({ data: 0 });
    responses["/api/workflow_api/delete"] = () => upstreamOk({ data: { status: 0 } });
    await softDeleteWorkflow(ORG_A, upstreamId("audit-append"));

    expect(await readAuditRows(ORG_A, "workflow.create")).toEqual(created);
  });
});

beforeAll(async () => {
  if (!databaseReachable) return;
  installDatabase();
  await cleanupTestRows();
});

afterAll(async () => {
  if (!databaseReachable) return;
  installDatabase();
  await cleanupTestRows();
  await closeTestPool();
});
