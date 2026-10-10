// 发布记录读路径（`GET /web/workflow-v2/workflows/:id/publish-records`）的行为契约。
//
// 这条端点支撑列表页的「日志」弹窗（上游当前发布版本 + 上游渠道发布记录 + 平台侧发布动作），重点断言五件事：
// ① 认证与归属：未认证 401、跨组织与不存在一律 404（对外同形，不泄漏存在性）；
// ② 未绑定租户 App 时读记录走 409（与创建、删除同一张绑定失败表）；
// ③ 记录来自**应用级**渠道发布读出口（工作流级的 `list_publish_workflow` 在上游是桩实现，见服务层文件头），
//    只搬运上游真实字段（版本、渠道结果、打包失败明细），上游空数组是**合法空态**而不是失败；
// ④ 平台侧发布动作来自本地审计流水（时间/操作人/结果），是控制台发布动作的唯一可见处；
// ⑤ 上游失败如实映射（业务失败 502、熔断 503），不吞成空列表——「读不到」与「上游说没有」是两件事。
//
// 夹具（数据库句柄、守卫与上游替身）在 `helpers/console-plane-harness.ts`；无数据库时整组跳过（显式打印原因）。

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createWebWorkflowV2Routes } from "../server/routes/web";
import { createWebWorkflowV2PublishRoutes } from "../server/routes/web/workflow-publish";
import { createWebWorkflowV2WorkflowRoutes } from "../server/routes/web/workflows";
import { recordAuditTrail } from "../server/services/audit-trail";
import { type UpstreamCallResult, UpstreamCircuitOpenError } from "../server/services/upstream-client";
import {
  cleanupTestRows,
  closeTestPool,
  createStubAuthGuard,
  createUpstreamStub,
  databaseReachable,
  installDatabase,
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

/** 应用级渠道发布记录端点的成功响应（`data[]` 是记录数组，元素形如上游 `PublishRecordDetail`）。 */
const recordsOk = (records: unknown[]) => upstreamOk({ data: records });
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

  // 主体路径：两条上游调用各自注入服务端解析出的身份（渠道记录用注册表的 appId，canvas 用上游 workflow ID +
  // 平台空间），记录只搬运上游真实字段；记录级状态由渠道结果与打包明细派生（上游记录级状态字段不可用）。
  test("读记录注入 appId 与 space_id 并归一化渠道结果与当前版本", async () => {
    const record = await seedRecord("records-ok", "v0.0.3");
    responses["/api/intelligence_api/publish/publish_record_list"] = () =>
      recordsOk([
        {
          publish_record_id: "1",
          version_number: "v0.0.2",
          publish_status: 0,
          connector_publish_result: [{ connector_id: "1024", connector_name: "API", connector_publish_status: 2 }],
        },
        {
          publish_record_id: "2",
          version_number: "v0.0.3",
          publish_status: 0,
          connector_publish_result: [{ connector_id: "1024", connector_name: "API", connector_publish_status: 0 }],
          publish_status_detail: { pack_failed_detail: [{ entity_name: "坏掉的工作流" }] },
        },
      ]);
    responses["/api/workflow_api/canvas"] = () => canvasOk("v0.0.3");

    const response = await request(app, `/workflows/${record.id}/publish-records`);
    const body = await readBody(response);

    expect(response.status).toBe(200);
    // project_id 取自本地注册表的 appId（客户端不参与）；canvas 读用上游 workflow ID + 平台空间。
    expect(sentBody(upstream.calls, 0)).toEqual({ project_id: record.appId });
    expect(sentBody(upstream.calls, 1)).toEqual({ workflow_id: record.upstreamWorkflowId, space_id: SPACE_ID });
    expect(body.data?.current).toEqual({ publishedVersion: "v0.0.3" });
    // 倒序展示（最近发布优先）；状态由真实字段派生：渠道全成功 → done，有打包失败明细 → pack_failed。
    expect(body.data?.records).toEqual([
      {
        version: "v0.0.3",
        status: "pack_failed",
        channels: [{ connectorId: "1024", connectorName: "API", status: "in_progress" }],
        packFailedResources: ["坏掉的工作流"],
      },
      {
        version: "v0.0.2",
        status: "done",
        channels: [{ connectorId: "1024", connectorName: "API", status: "success" }],
        packFailedResources: [],
      },
    ]);
    // 平台侧动作来自本地审计流水：本用例没有发布动作，因此是空数组（不是 null，也不是伪造的一行）。
    expect(body.data?.actions).toEqual([]);
  });

  // 上游没有渠道发布记录时返回空数组：这是**合法空态**（应用从未发布到渠道），不得报错、也不得用本地版本
  // 伪造一条记录（否则界面上的「暂无记录」会变成永远不出现的分支）。
  test("上游无渠道发布记录时返回空数组且不伪造本地数据", async () => {
    const record = await seedRecord("records-null", "v0.0.1");
    responses["/api/intelligence_api/publish/publish_record_list"] = () => recordsOk([]);
    responses["/api/workflow_api/canvas"] = () => canvasOk(null);

    const response = await request(app, `/workflows/${record.id}/publish-records`);
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expect(body.data?.records).toEqual([]);
    // 上游未记录发布版本（回空串）时如实为 null：本地登记的 v0.0.1 不进这个字段。
    expect(body.data?.current).toEqual({ publishedVersion: null });
  });

  // 认不出的渠道状态码如实为 null（不猜成成功/失败），记录级状态随之落到 in_progress：
  // 不认识的取值不该被翻译成一个看似精确的结论。
  test("认不出的渠道状态码归一为 null 且记录状态保守落在进行中", async () => {
    const record = await seedRecord("records-unknown-code");
    responses["/api/intelligence_api/publish/publish_record_list"] = () =>
      recordsOk([
        {
          version_number: "v9.9.9",
          connector_publish_result: [{ connector_id: "999", connector_name: null, connector_publish_status: 42 }],
        },
      ]);
    responses["/api/workflow_api/canvas"] = () => canvasOk("v9.9.9");

    const body = await readBody(await request(app, `/workflows/${record.id}/publish-records`));

    expect(body.data?.records).toHaveLength(1);
    expect(body.data?.records?.[0]?.status).toBe("in_progress");
    expect(body.data?.records?.[0]?.channels?.[0]?.status).toBeNull();
  });

  // 平台侧发布动作来自本地审计流水：控制台的发布动作在上游**没有任何记录**，这一段是「我点过的发布结果如何」
  // 的唯一来源，因此必须随响应返回，并只收本组织 + 本 workflow 的行。
  test("平台侧发布动作随响应返回且按组织与 workflow 过滤", async () => {
    const record = await seedRecord("records-actions");
    responses["/api/intelligence_api/publish/publish_record_list"] = () => recordsOk([]);
    responses["/api/workflow_api/canvas"] = () => canvasOk("v0.0.1");
    await recordAuditTrail({
      organizationId: ORG_A,
      actorUserId: OWNER_ID,
      action: "workflow.publish",
      upstreamWorkflowId: record.upstreamWorkflowId,
      result: "ok",
      errorCode: null,
    });
    // 别的组织、以及同一组织的别的动作，都不得混进来。
    await recordAuditTrail({
      organizationId: `${ORG_A}-other`,
      actorUserId: OWNER_ID,
      action: "workflow.publish",
      upstreamWorkflowId: record.upstreamWorkflowId,
      result: "failed",
      errorCode: "INTERNAL_ERROR",
    });
    await recordAuditTrail({
      organizationId: ORG_A,
      actorUserId: OWNER_ID,
      action: "workflow.create",
      upstreamWorkflowId: record.upstreamWorkflowId,
      result: "ok",
      errorCode: null,
    });

    const body = await readBody(await request(app, `/workflows/${record.id}/publish-records`));

    expect(body.data?.actions).toHaveLength(1);
    expect(body.data?.actions?.[0]).toMatchObject({ result: "ok", errorCode: null });
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
    responses["/api/intelligence_api/publish/publish_record_list"] = () => upstreamFail(777777775, "boom");
    responses["/api/workflow_api/canvas"] = () => canvasOk("v0.0.1");

    const response = await request(app, `/workflows/${record.id}/publish-records`);

    expect(response.status).toBe(502);
    expect((await readBody(response)).error?.code).toBe("UPSTREAM_REJECTED");
  });

  // canvas 那一半失败同样要暴露：只报「记录可用、版本未知」会让漂移比对静默失效。
  test("canvas 读取失败时整体失败而非降级", async () => {
    const record = await seedRecord("records-canvas-failed");
    responses["/api/intelligence_api/publish/publish_record_list"] = () => recordsOk([]);
    responses["/api/workflow_api/canvas"] = () => upstreamFail(700012006, "authentication failed: session not exist");

    const response = await request(app, `/workflows/${record.id}/publish-records`);

    expect(response.status).toBe(502);
    expect((await readBody(response)).error?.code).toBe("UPSTREAM_REJECTED");
  });

  // 熔断打开是「没发出请求的失败」：503 让界面知道这是暂不可用（可稍后重试），不是「上游说没有记录」。
  test("熔断打开时读记录返回 503", async () => {
    const record = await seedRecord("records-circuit");
    responses["/api/intelligence_api/publish/publish_record_list"] = () => {
      throw new UpstreamCircuitOpenError("/api/intelligence_api/publish/publish_record_list", 1000);
    };

    const response = await request(app, `/workflows/${record.id}/publish-records`);

    expect(response.status).toBe(503);
    expect((await readBody(response)).error?.code).toBe("UPSTREAM_UNAVAILABLE");
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
