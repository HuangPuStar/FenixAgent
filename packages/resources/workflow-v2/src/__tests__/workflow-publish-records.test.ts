// 发布记录读路径（`GET /web/workflow-v2/workflows/:id/publish-records`）的行为契约。
//
// 这条端点支撑列表页的「日志」弹窗（发布记录 + 上游当前发布版本），因此重点断言四件事：
// ① 认证与归属：未认证 401、跨组织与不存在一律 404（对外同形，不泄漏存在性）；
// ② 未绑定租户 App 时读记录走 409（与发布、创建同一张绑定失败表）；
// ③ 归一化：发布记录全部来自上游、缺失字段如实为 null，上游 `data:null` 是**合法空态**而不是失败；
// ④ 上游失败如实映射（业务失败 502、熔断 503），不吞成空列表——「读不到」与「上游说没有」是两件事。
//
// 夹具（数据库句柄、守卫与上游替身）在 `helpers/console-plane-harness.ts`；无数据库时整组跳过（显式打印原因）。

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createWebWorkflowV2Routes } from "../server/routes/web";
import { createWebWorkflowV2PublishRoutes } from "../server/routes/web/workflow-publish";
import { createWebWorkflowV2WorkflowRoutes } from "../server/routes/web/workflows";
import { type UpstreamCallResult, UpstreamCircuitOpenError } from "../server/services/upstream-client";
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
  readBody,
  request,
  SPACE_ID,
  seedBinding,
  seedRecord,
  sentBody,
  upstreamFail,
  upstreamOk,
} from "./helpers/console-plane-harness";

type Responses = Record<string, () => UpstreamCallResult | Promise<UpstreamCallResult>>;

/** 把 CRUD 与发布（含记录读）两条子路由装到一个应用上：发布记录端点归 `workflow-publish.ts`。 */
function createConsolePlaneApp(
  guard: ReturnType<typeof createStubAuthGuard>,
  upstream: ReturnType<typeof createUpstreamStub>,
) {
  return new Elysia()
    .use(createWebWorkflowV2WorkflowRoutes({ authGuardPlugin: guard.plugin }, { callUpstream: upstream.call }))
    .use(createWebWorkflowV2PublishRoutes({ authGuardPlugin: guard.plugin }, { callUpstream: upstream.call }));
}

/** 上游发布记录端点的成功响应（`data.workflows[]` 是记录数组；上游空态是 `data:null`）。 */
const recordsOk = (workflows: unknown[]) => upstreamOk({ data: { workflows, total: workflows.length } });
/** 上游 canvas 端点的成功响应：本模块只消费 `data.workflow_version`。 */
const canvasOk = (publishedVersion: string | null) =>
  upstreamOk({ data: { workflow_version: publishedVersion ?? "", workflow: { schema_json: "{}" } } });

describe("发布记录读路径挂在 /workflow-v2 聚合入口下", () => {
  // 挂载判据与发布写路径同款：新端点必须挂在宿主真正使用的聚合入口（`routes/web/index.ts`）下，
  // 只挂在子工厂上会是运行时 404，而子工厂的单测发现不了。未认证 → 401 即证明路由存在。
  test("未认证时发布记录端点返回 401", async () => {
    const guard = createStubAuthGuard();
    const app = createWebWorkflowV2Routes({ authGuardPlugin: guard.plugin });

    const response = await app.handle(new Request("http://localhost/workflow-v2/workflows/any-id/publish-records"));

    expect(response.status).toBe(401);
    expect((await readBody(response)).error?.code).toBe("UNAUTHENTICATED");
  });
});

describe.skipIf(!databaseReachable)("发布记录与上游身份解析（真实 Postgres + 上游替身）", () => {
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

  // 主体路径：两条上游调用都注入平台空间的 space_id（客户端自报值不参与），记录按 workflow_ids 收窄，
  // 缺失字段如实为 null；canvas 的 workflow_version 是「上游当前版本」的唯一来源。
  test("读记录注入 space_id 并归一化上游记录与当前版本", async () => {
    const record = await seedRecord("records-ok", "v0.0.3");
    responses["/api/workflow_api/list_publish_workflow"] = () =>
      recordsOk([
        {
          basic_info: {
            id: record.upstreamWorkflowId,
            name: "客服问答流程",
            publish_time: 1_760_000_000,
            owner_id: "u-1",
          },
        },
      ]);
    responses["/api/workflow_api/canvas"] = () => canvasOk("v0.0.3");

    const response = await request(app, `/workflows/${record.id}/publish-records`);
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expect(sentBody(upstream.calls, 0)).toEqual({
      space_id: SPACE_ID,
      workflow_ids: [record.upstreamWorkflowId],
      size: 20,
    });
    expect(sentBody(upstream.calls, 1)).toEqual({ workflow_id: record.upstreamWorkflowId, space_id: SPACE_ID });
    expect(body.data?.current).toEqual({ publishedVersion: "v0.0.3" });
    expect(body.data?.records).toEqual([
      {
        workflowId: record.upstreamWorkflowId,
        name: "客服问答流程",
        publishedAt: new Date(1_760_000_000 * 1000).toISOString(),
        ownerId: "u-1",
      },
    ]);
  });

  // 当前上游构建的 `list_publish_workflow` 是桩实现（返回 `data:null`）：空记录是**合法空态**，
  // 不得报错、也不得用本地版本伪造一条记录（否则界面上的「暂无记录」会变成永远不出现的分支）。
  test("上游 data:null 时返回空记录且不伪造本地数据", async () => {
    const record = await seedRecord("records-null", "v0.0.1");
    responses["/api/workflow_api/list_publish_workflow"] = () => upstreamOk({ data: null });
    responses["/api/workflow_api/canvas"] = () => canvasOk(null);

    const response = await request(app, `/workflows/${record.id}/publish-records`);
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expect(body.data?.records).toEqual([]);
    // 上游未记录发布版本（回空串）时如实为 null：本地登记的 v0.0.1 不进这个字段。
    expect(body.data?.current).toEqual({ publishedVersion: null });
  });

  // 上游忽略 workflow_ids 时必须自行过滤：把别的 workflow 的记录显示在当前 workflow 名下比空列表更糟。
  test("过滤掉不属于该 workflow 的上游记录", async () => {
    const record = await seedRecord("records-filter");
    responses["/api/workflow_api/list_publish_workflow"] = () =>
      recordsOk([
        { basic_info: { id: "someone-else", name: "别人的流程" } },
        { basic_info: { id: record.upstreamWorkflowId } },
      ]);
    responses["/api/workflow_api/canvas"] = () => canvasOk("v1.0.0");

    const body = await readBody(await request(app, `/workflows/${record.id}/publish-records`));

    expect(body.data?.records).toHaveLength(1);
    expect(body.data?.records?.[0]?.name).toBeNull();
  });

  // 只读端点同样按本地注册表做归属判定：别的组织的记录对外与「不存在」同形（404），不泄漏存在性。
  test("跨组织读记录返回 404", async () => {
    const foreign = await seedRecord("records-foreign", null, ORG_B);

    const response = await request(app, `/workflows/${foreign.id}/publish-records`);

    expect(response.status).toBe(404);
    expect((await readBody(response)).error?.code).toBe("WORKFLOW_NOT_FOUND");
    // 归属判定在绑定与上游调用之前：不该有任何上游流量。
    expect(upstream.calls).toHaveLength(0);
  });

  // 未绑定租户 App 时没有可注入的 space_id，读记录与发布、创建走同一张绑定失败表（409 可引导修复）。
  test("未绑定租户 App 时读记录返回 409", async () => {
    // ORG_B 没有被 `seedBinding` 建过绑定，且记录归属也在 ORG_B：归属判定通过、绑定判定拦住。
    const record = await seedRecord("records-unbound", null, ORG_B);
    guard.setActor({ organizationId: ORG_B, userId: OWNER_ID });

    const response = await request(app, `/workflows/${record.id}/publish-records`);

    expect(response.status).toBe(409);
    expect((await readBody(response)).error?.code).toBe("ORG_APP_NOT_BOUND");
  });

  // 上游业务失败不是空列表：如实映射为 502，让界面上给出「重试」而不是「暂无记录」。
  test("上游业务失败映射 502 且不退回空态", async () => {
    const record = await seedRecord("records-rejected");
    responses["/api/workflow_api/list_publish_workflow"] = () => upstreamFail(777777775, "boom");
    responses["/api/workflow_api/canvas"] = () => canvasOk("v0.0.1");

    const response = await request(app, `/workflows/${record.id}/publish-records`);

    expect(response.status).toBe(502);
    expect((await readBody(response)).error?.code).toBe("UPSTREAM_REJECTED");
  });

  // canvas 那一半失败同样要暴露：只报「记录可用、版本未知」会让漂移比对静默失效。
  test("canvas 读取失败时整体失败而非降级", async () => {
    const record = await seedRecord("records-canvas-failed");
    responses["/api/workflow_api/list_publish_workflow"] = () => recordsOk([]);
    responses["/api/workflow_api/canvas"] = () => upstreamFail(700012006, "authentication failed: session not exist");

    const response = await request(app, `/workflows/${record.id}/publish-records`);

    expect(response.status).toBe(502);
    expect((await readBody(response)).error?.code).toBe("UPSTREAM_REJECTED");
  });

  // 熔断打开是「没发出请求的失败」：503 让界面知道这是暂不可用（可稍后重试），不是「上游说没有记录」。
  test("熔断打开时读记录返回 503", async () => {
    const record = await seedRecord("records-circuit");
    responses["/api/workflow_api/list_publish_workflow"] = () => {
      throw new UpstreamCircuitOpenError("/api/workflow_api/list_publish_workflow", 1000);
    };

    const response = await request(app, `/workflows/${record.id}/publish-records`);

    expect(response.status).toBe(503);
    expect((await readBody(response)).error?.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  // 已经挂在这个应用上的发布写路径不能被新只读端点影响：存在性校验仍是 404（回归线）。
  test("发布端点行为不因新增只读端点改变", async () => {
    const record = await seedRecord("publish-still-works");
    responses["/api/workflow_api/publish"] = () =>
      upstreamOk({ data: { publish_commit_id: "commit-9", success: true } });

    const response = await request(app, `/workflows/${record.id}/publish`, jsonInit("POST", { force: true }));

    expect(response.status).toBe(200);
    expect((await readBody(response)).data?.version).toBe("v0.0.1");
  });
});

// 收尾与另两份控制面用例同款：先复位守卫再清测试行（只看 `wf2-test-` 前缀），最后关掉本进程的连接池。
beforeAll(async () => {
  if (!databaseReachable) return;
  installDatabase();
});

afterAll(async () => {
  if (!databaseReachable) return;
  installDatabase();
  await cleanupTestRows();
  await closeTestPool();
});
