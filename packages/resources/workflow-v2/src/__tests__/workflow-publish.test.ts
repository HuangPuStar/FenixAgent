// 控制面发布闭环（3B）与审计接入（3C）的行为契约。
//
// 发布是本次唯一「写上游版本 + 写本地版本」的动作，因此重点断言三件事：版本号按上游的 SemVer 口径自增
// （首发布 v0.0.1、其后 patch+1，依据见 `services/workflow-publish.ts` 文件头）、上游业务拒绝被原样映射成
// 控制面错误且**不改动本地状态**、发布成功才把版本写回注册表。
//
// 审计用真实 `workflow_v2_audit_log` 表断言（只追加、不更新删除）：每行必须能回答「谁、对哪个 workflow、
// 做了什么、结果如何」。夹具（数据库句柄、守卫与上游替身）在 `helpers/console-plane-harness.ts`。

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createWebWorkflowV2Routes } from "../server/routes/web";
import { createWebWorkflowV2PublishRoutes } from "../server/routes/web/workflow-publish";
import { createWebWorkflowV2WorkflowRoutes } from "../server/routes/web/workflows";
import type { UpstreamCallResult } from "../server/services/upstream-client";
import { UpstreamCircuitOpenError } from "../server/services/upstream-client";
import { INITIAL_PUBLISH_VERSION, nextPublishVersion, parsePublishVersion } from "../server/services/workflow-publish";
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
  ORG_B,
  OWNER_ID,
  readAuditRows,
  readBody,
  readRawRow,
  request,
  SPACE_ID,
  seedBinding,
  seedRecord,
  sentBody,
  upstreamFail,
  upstreamId,
  upstreamOk,
} from "./helpers/console-plane-harness";

type Responses = Record<string, () => UpstreamCallResult | Promise<UpstreamCallResult>>;

/** 把两条子路由（CRUD 与发布）装到一个应用上：发布与审计用例共用守卫与上游替身，避免两套替身漂移。 */
function createConsolePlaneApp(
  guard: ReturnType<typeof createStubAuthGuard>,
  upstream: ReturnType<typeof createUpstreamStub>,
) {
  return new Elysia()
    .use(createWebWorkflowV2WorkflowRoutes({ authGuardPlugin: guard.plugin }, { callUpstream: upstream.call }))
    .use(createWebWorkflowV2PublishRoutes({ authGuardPlugin: guard.plugin }, { callUpstream: upstream.call }));
}

describe("发布版本自增（纯函数）", () => {
  // 首发布的版本必须与上游控制台一致（`v0.0.1`）：用户在两处看到的版本序列相同，才不会出现「画布里发过
  // 一次、控制台发第二次」时的版本冲突。
  test("首次发布取 v0.0.1", () => {
    expect(INITIAL_PUBLISH_VERSION).toBe("v0.0.1");
    expect(nextPublishVersion(null)).toBe("v0.0.1");
  });

  // 已发布过就在同 major.minor 上 patch+1（上游前端 `semver.inc(version, 'patch')` 的同义实现），
  // 且必须**严格大于**上游记录的版本，否则上游会以「未自增」拒绝。
  test("已发布版本按 patch 自增", () => {
    expect(nextPublishVersion("v0.0.1")).toBe("v0.0.2");
    expect(nextPublishVersion("v1.2.9")).toBe("v1.2.10");
    expect(parsePublishVersion("v1.2.10")).toEqual({ major: 1, minor: 2, patch: 10 });
  });

  // 本地版本号形状不合法时返回 null（调用方拒绝发布）：拿一个伪造版本去撞上游只会得到「未自增」，
  // 错误信息指向版本号而掩盖真因（本地数据坏了）。
  test("不可解析的版本号返回 null", () => {
    for (const invalid of ["1.0.0", "v1.0", "v1.0.0-beta", "v1.0.x", ""]) {
      expect(parsePublishVersion(invalid)).toBeNull();
    }
    expect(nextPublishVersion("1.0.0")).toBeNull();
  });
});

describe("控制面聚合入口", () => {
  // 发布路由必须挂在宿主真正使用的聚合入口（`routes/web/index.ts`）下：挂在子工厂上不等于挂在入口下，
  // 少一次 `.use()` 就会在运行时变成 404，而子工厂的单测发现不了。未认证 → 401 即证明路由存在。
  test("发布路由挂在 /workflow-v2 聚合入口下", async () => {
    const guard = createStubAuthGuard();
    const app = createWebWorkflowV2Routes({ authGuardPlugin: guard.plugin });

    const response = await app.handle(
      new Request("http://localhost/workflow-v2/workflows/any-id/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect(response.status).toBe(401);
    expect((await readBody(response)).error?.code).toBe("UNAUTHENTICATED");
  });
});

describe.skipIf(!databaseReachable)("控制面发布闭环（真实 Postgres + 上游替身）", () => {
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

  // 首发布：版本号由服务端生成（v0.0.1），必填字段与注入值一次断言到位——space_id 取平台账号、
  // has_collaborator 是 thrift 必填但平台账号是唯一用户（恒 false）；客户端自报的 space_id 一律被剥离。
  test("首次发布注入 space_id 与生成版本，成功后写回本地并记审计", async () => {
    const record = await seedRecord("first-publish");
    responses["/api/workflow_api/publish"] = () =>
      upstreamOk({ data: { publish_commit_id: "commit-1", success: true } });

    const response = await request(
      app,
      `/workflows/${record.id}/publish`,
      jsonInit("POST", { description: "首个版本", space_id: "客户端伪造", force: false }),
    );
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ version: "v0.0.1", commitId: "commit-1" });
    expect(sentBody(upstream.calls, 0)).toEqual({
      workflow_id: record.upstreamWorkflowId,
      space_id: SPACE_ID,
      has_collaborator: false,
      workflow_version: "v0.0.1",
      version_description: "首个版本",
    });
    expect((await readRawRow(record.upstreamWorkflowId))?.publishedVersion).toBe("v0.0.1");
    expect(await readAuditRows(ORG_A, "workflow.publish")).toContainEqual({
      upstreamWorkflowId: record.upstreamWorkflowId,
      result: "ok",
      errorCode: null,
      actorUserId: OWNER_ID,
      requestId: null,
    });
  });

  // 已发布过时必须自增（上游会校验严格递增），且 `force` 只在显式 true 时直传：缺省保持上游「草稿必须先
  // 通过 test_run」的严格口径，不把强制发布变成默认语义。
  test("已发布过的发布会自增版本并直传 force", async () => {
    const record = await seedRecord("increment", "v0.0.7");
    responses["/api/workflow_api/publish"] = () => upstreamOk({ data: { success: true } });

    const forced = await readBody(
      await request(app, `/workflows/${record.id}/publish`, jsonInit("POST", { force: true })),
    );

    expect(forced.data?.version).toBe("v0.0.8");
    expect(sentBody(upstream.calls, 0).force).toBe(true);
    expect((await readRawRow(record.upstreamWorkflowId))?.publishedVersion).toBe("v0.0.8");
  });

  // 「草稿未通过 test_run」是上游的业务拒绝（777777775 + 固定文案）：必须原样映射成可操作的控制面错误，
  // 且**不**改动本地版本——本地版本只在发布成功时前进，否则下一次自增会跳过上游没发布过的版本。
  test("草稿未验证时映射 409 且不改动本地版本", async () => {
    const record = await seedRecord("draft-unverified");
    responses["/api/workflow_api/publish"] = () =>
      upstreamFail(
        777777775,
        "Workflow operation failure: workflow 1's current draft needs to pass the test run before publishing",
      );

    const response = await request(app, `/workflows/${record.id}/publish`, jsonInit("POST", {}));

    expect(response.status).toBe(409);
    expect((await readBody(response)).error?.code).toBe("WORKFLOW_DRAFT_NOT_VERIFIED");
    expect((await readRawRow(record.upstreamWorkflowId))?.publishedVersion).toBeNull();
    expect((await readAuditRows(ORG_A, "workflow.publish")).map((row) => row.result)).toContain("upstream_rejected");
  });

  // 两种 777777775 的另一种：版本未严格递增（本地版本落后于上游）必须与「草稿未验证」区分开，
  // 否则用户按错误提示去跑一遍 test_run 也解决不了问题。
  test("版本未自增映射 409 且提示对账", async () => {
    const record = await seedRecord("not-incremental", "v0.0.1");
    responses["/api/workflow_api/publish"] = () =>
      upstreamFail(
        777777775,
        "the version number is not self-incrementing, old version v0.0.9, current version v0.0.2",
      );

    const response = await request(app, `/workflows/${record.id}/publish`, jsonInit("POST", {}));

    expect(response.status).toBe(409);
    expect((await readBody(response)).error?.code).toBe("WORKFLOW_VERSION_NOT_INCREMENTAL");
  });

  // 777777769 是「版本名非法」：本地已保证总带合法 SemVer，真出现说明上游有本模块之外的记录，
  // 按状态冲突映射（409），上游码只进日志。
  test("版本名非法映射 409", async () => {
    const record = await seedRecord("version-invalid");
    responses["/api/workflow_api/publish"] = () => upstreamFail(777777769, "workflow version name is invalid");

    const response = await request(app, `/workflows/${record.id}/publish`, jsonInit("POST", {}));

    expect(response.status).toBe(409);
    expect((await readBody(response)).error?.code).toBe("WORKFLOW_VERSION_INVALID");
  });

  // 本地版本不可解析时拒绝发布且不调上游：这是本地数据坏掉的信号，猜一个版本号送上去只会得到误导性的
  // 「未自增」错误，掩盖真因。
  test("本地版本不可解析时拒绝发布且不触上游", async () => {
    const record = await seedRecord("unparseable", "1.0.0");

    const response = await request(app, `/workflows/${record.id}/publish`, jsonInit("POST", {}));

    expect(response.status).toBe(500);
    expect((await readBody(response)).error?.code).toBe("WORKFLOW_VERSION_UNPARSEABLE");
    expect(upstream.calls).toHaveLength(0);
    expect((await readAuditRows(ORG_A, "workflow.publish")).map((row) => row.errorCode)).toContain(
      "WORKFLOW_VERSION_UNPARSEABLE",
    );
  });

  // 熔断打开时 upstream 层直接抛短路错误：控制面必须映射 503（可重试的上游不可用），而不是 500 或 502。
  test("上游熔断打开时映射 503", async () => {
    const record = await seedRecord("circuit-open");
    responses["/api/workflow_api/publish"] = () => {
      throw new UpstreamCircuitOpenError("/api/workflow_api/publish", 30_000);
    };

    const response = await request(app, `/workflows/${record.id}/publish`, jsonInit("POST", {}));

    expect(response.status).toBe(503);
    expect((await readBody(response)).error?.code).toBe("UPSTREAM_UNAVAILABLE");
    expect((await readAuditRows(ORG_A, "workflow.publish")).map((row) => row.result)).toContain("upstream_unavailable");
  });

  // 跨组织的 workflow 对当前组织不可见：404、不调上游、不写审计（存在性不泄漏，也不能把探测写进对方流水）。
  test("跨组织发布返回 404 且不触上游", async () => {
    const foreign = await seedRecord("foreign", null, ORG_B);

    const response = await request(app, `/workflows/${foreign.id}/publish`, jsonInit("POST", {}));

    expect(response.status).toBe(404);
    expect(upstream.calls).toHaveLength(0);
    // 同组织的其它用例会留下发布流水，这里只断言「本次目标没有任何流水」。
    expect((await readAuditRows(ORG_A, "workflow.publish")).map((row) => row.upstreamWorkflowId)).not.toContain(
      foreign.upstreamWorkflowId,
    );
  });
});

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
