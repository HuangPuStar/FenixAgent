// 单次运行出入参数读路径（`GET /web/workflow-v2/run-records/:executeId/io`）的行为契约。
//
// 上游没有运行级的 input/output 字段，出入参数只能按 execute id 读 `GET /api/workflow_api/get_process` 的
// 节点结果并取「Start 的 input / End 的 output」（映射口径见 `services/workflow-run-io.ts` 文件头；实测样本
// 见该文件的契约备注）。重点断言六件事：
// ① 认证与归属：未认证 401；`upstreamWorkflowId` 跨组织与不存在一律 404（对外同形，不泄漏存在性）且不触达上游；
// ② 请求口径：只送上游声明的三个 query（`workflow_id` 取注册表里的上游 ID、`space_id` 取绑定行、`execute_id`
//    取路径参数），方法恒为 GET；
// ③ 取值口径：Start 节点的 `input` 是运行输入、End 节点的 `output` 是运行输出；END 的 `output` 为空串时回退
//    `raw_output`（画布对「输出」有两个字段）；缺节点、空串一律 null——不猜、不造默认值；
// ④ 未绑定租户 App 时 409（与清单、发布同一张绑定失败表）；
// ⑤ 失败语义：上游业务失败 / HTTP 非 2xx 一律 502 且不回传上游原文；熔断 503；超时 504；
// ⑥ 挂载：新端点挂在宿主真正使用的聚合入口（`routes/web/index.ts`）下，只挂子工厂会是运行时 404。
//
// 夹具（数据库句柄、守卫与上游替身）在 `helpers/console-plane-harness.ts`；无数据库时整组跳过（显式打印原因）。

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createWebWorkflowV2Routes } from "../server/routes/web";
import { createWebWorkflowV2RunRoutes } from "../server/routes/web/workflow-runs";
import {
  type UpstreamCallResult,
  UpstreamCircuitOpenError,
  UpstreamRequestError,
} from "../server/services/upstream-client";
import {
  cleanupTestRows,
  closeTestPool,
  createStubAuthGuard,
  createUpstreamStub,
  databaseReachable,
  installDatabase,
  ORG_A,
  OWNER_ID,
  readBody,
  request,
  SPACE_ID,
  seedBinding,
  seedRecord,
  upstreamFail,
  upstreamOk,
} from "./helpers/console-plane-harness";

type Responses = Record<string, () => UpstreamCallResult | Promise<UpstreamCallResult>>;

const GET_PROCESS_PATH = "/api/workflow_api/get_process";

/** 目标运行的 execute id（上游 `workflow_execution.id` 的字符串形态）。 */
const EXECUTE_ID = "7694582493076258816";

/**
 * 一条节点结果：只保留本端点读的字段（`NodeType` / `input` / `output` / `raw_output`）。
 *
 * 上游节点结果共 13 个字段，其余字段本端点不消费——用例刻意不补，让「服务端多读了字段」无法被 fixture 掩盖。
 */
const nodeResult = (type: string, fields: { input?: string; output?: string; raw_output?: string } = {}) => ({
  nodeId: `node-${type.toLowerCase()}`,
  NodeType: type,
  NodeName: type,
  nodeStatus: 3,
  ...fields,
});

/** 上游 `get_process` 的成功响应：标准包裹 `{code, msg, data}`，节点结果在 `data.nodeResults`。 */
const processOk = (nodeResults: unknown) => upstreamOk({ data: { executeStatus: 2, nodeResults } });

/** 把运行路由装到一个应用上（上游端口注入替身）。 */
function createRunPlaneApp(
  guard: ReturnType<typeof createStubAuthGuard>,
  upstream: ReturnType<typeof createUpstreamStub>,
) {
  return new Elysia().use(
    createWebWorkflowV2RunRoutes({ authGuardPlugin: guard.plugin }, { callUpstream: upstream.call }),
  );
}

describe("出入参数读路径挂在 /workflow-v2 聚合入口下", () => {
  // 挂载判据与清单端点同款：新端点必须挂在宿主真正使用的聚合入口下，只挂在子工厂上会是运行时 404，
  // 而子工厂的单测发现不了。未认证 → 401 即证明路由存在。
  test("未认证时出入参数端点返回 401", async () => {
    const guard = createStubAuthGuard();
    const app = createWebWorkflowV2Routes({ authGuardPlugin: guard.plugin });

    const response = await app.handle(
      new Request(`http://localhost/workflow-v2/run-records/${EXECUTE_ID}/io?upstreamWorkflowId=up-1`),
    );

    expect(response.status).toBe(401);
    expect((await readBody(response)).error?.code).toBe("UNAUTHENTICATED");
  });
});

describe.skipIf(!databaseReachable)("单次运行的出入参数（真实 Postgres + 上游替身）", () => {
  const guard = createStubAuthGuard();
  let responses: Responses;
  let upstream: ReturnType<typeof createUpstreamStub>;
  let app: Elysia;

  beforeEach(async () => {
    installDatabase();
    await seedBinding();
    responses = {};
    upstream = createUpstreamStub(responses);
    app = createRunPlaneApp(guard, upstream);
    guard.setActor({ organizationId: ORG_A, userId: OWNER_ID });
  });

  afterAll(async () => {
    guard.setActor(null);
    await cleanupTestRows();
    await closeTestPool();
  });

  // 请求口径与清单端点同源：`workflow_id` 取注册表里的上游 ID（客户端不接触上游 ID，路径参数只有 execute id）、
  // `space_id` 取绑定行的平台空间、`execute_id` 取路径参数；方法恒为 GET（该端点只挂 GET，POST 调用返回 404）。
  test("按 execute id 读上游节点结果，query 只含上游声明的三个字段", async () => {
    const record = await seedRecord("run-io");
    responses[GET_PROCESS_PATH] = () =>
      processOk([nodeResult("Start", { input: '{"hello":"io-probe"}' }), nodeResult("End", { output: '{"ok":true}' })]);

    const response = await request(
      app,
      `/run-records/${EXECUTE_ID}/io?upstreamWorkflowId=${record.upstreamWorkflowId}`,
    );
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ input: '{"hello":"io-probe"}', output: '{"ok":true}' });
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.path).toBe(GET_PROCESS_PATH);
    expect(upstream.calls[0]?.method).toBe("GET");
    // 键集完全相等才是「不多送」的判据：多送的 query 会悄悄改变上游的查询语义，而那种偏移在上层断言里看不出来。
    expect(Object.keys(upstream.calls[0]?.query ?? {}).sort()).toEqual(["execute_id", "space_id", "workflow_id"]);
    expect(upstream.calls[0]?.query).toEqual({
      workflow_id: record.upstreamWorkflowId,
      space_id: SPACE_ID,
      execute_id: EXECUTE_ID,
    });
  });

  // 画布对「节点输出」有两个字段：`output` 是主口径，为空串时 `raw_output` 是上游自己保留的原样输出。
  // 空串与缺失在上屏口径上不区分（都显示「上游未提供」），因此空串一律归一成 null 后再回退。
  test("End 输出为空串时回退 raw_output，Start 输入为空串一律 null", async () => {
    const record = await seedRecord("run-io-raw");
    responses[GET_PROCESS_PATH] = () =>
      processOk([nodeResult("Start", { input: "" }), nodeResult("End", { output: "", raw_output: '{"raw":1}' })]);

    const body = await readBody(
      await request(app, `/run-records/${EXECUTE_ID}/io?upstreamWorkflowId=${record.upstreamWorkflowId}`),
    );

    expect(body.data).toEqual({ input: null, output: '{"raw":1}' });
  });

  // 节点缺失（节点调试运行、上游只回部分节点）或节点类型认不出时一律 null：出入参数只在能确定来源时才给，
  // 拿别的节点顶替会把「这次运行的这个节点」说成「这次运行的输入/输出」。
  test("缺 Start / End 节点时字段为 null 且不从其它节点顶替", async () => {
    const record = await seedRecord("run-io-missing");
    responses[GET_PROCESS_PATH] = () =>
      // 只有 LLM 节点、且类型用数字形态（schema 里的 "3"）：数字形态不是实测口径，这里同时钉住「认不出就不猜」。
      processOk([{ nodeId: "node-llm", NodeType: "3", input: '{"x":1}', output: '{"y":2}' }]);

    const body = await readBody(
      await request(app, `/run-records/${EXECUTE_ID}/io?upstreamWorkflowId=${record.upstreamWorkflowId}`),
    );

    expect(body.data).toEqual({ input: null, output: null });

    // `nodeResults` 缺失/为 null（上游在旧运行上可能回空壳）同样按「没有节点结果」处理，不抛错。
    responses[GET_PROCESS_PATH] = () => upstreamOk({ data: { executeStatus: 2, nodeResults: null } });
    const empty = await readBody(
      await request(app, `/run-records/${EXECUTE_ID}/io?upstreamWorkflowId=${record.upstreamWorkflowId}`),
    );
    expect(empty.data).toEqual({ input: null, output: null });
  });

  // 只读端点同样按本地注册表做归属判定：别的组织的上游 ID 对外与「不存在」同形（404），不泄漏存在性，
  // 也不产生任何上游流量。
  test("跨组织的 upstreamWorkflowId 返回 404 且不触达上游", async () => {
    const foreign = await seedRecord("run-io-foreign", null, `${ORG_A}-b`);

    const response = await request(
      app,
      `/run-records/${EXECUTE_ID}/io?upstreamWorkflowId=${foreign.upstreamWorkflowId}`,
    );

    expect(response.status).toBe(404);
    expect((await readBody(response)).error?.code).toBe("WORKFLOW_NOT_FOUND");
    expect(upstream.calls).toHaveLength(0);
  });

  // 未绑定租户 App 时没有可用的绑定上下文（也就没有 `space_id`）：与清单、发布走同一张绑定失败表（409 可引导
  // 修复），同样不触发上游调用。
  test("未绑定租户 App 时返回 409 且不触达上游", async () => {
    const record = await seedRecord("run-io-unbound", null, `${ORG_A}-c`);
    guard.setActor({ organizationId: `${ORG_A}-c`, userId: OWNER_ID });

    const response = await request(
      app,
      `/run-records/${EXECUTE_ID}/io?upstreamWorkflowId=${record.upstreamWorkflowId}`,
    );

    expect(response.status).toBe(409);
    expect((await readBody(response)).error?.code).toBe("ORG_APP_NOT_BOUND");
    expect(upstream.calls).toHaveLength(0);
  });

  // 上游业务失败（`code≠0`）如实映射为 502，且不回传上游原文（`msg` 可能含内部路径与 Go 堆栈）。
  test("上游业务失败映射为 502 且不回传上游原文", async () => {
    const record = await seedRecord("run-io-rejected");
    responses[GET_PROCESS_PATH] = () => upstreamFail(777777775, "panic: strconv.ParseInt: /srv/app/internal.go:42");

    const response = await request(
      app,
      `/run-records/${EXECUTE_ID}/io?upstreamWorkflowId=${record.upstreamWorkflowId}`,
    );
    const body = await readBody(response);

    expect(response.status).toBe(502);
    expect(body.error?.code).toBe("UPSTREAM_REJECTED");
    expect(body.error?.message).not.toContain("panic");
    expect(body.data).toBeUndefined();
  });

  // 成功判定是「HTTP 200 **且** `code === 0`」两件事：上游回了业务码 0 但 HTTP 非 2xx（网关/反代故障态）同样
  // 不算成功——放行会把一次未必成立的读取当成「这次运行没有出入参数」。
  test("上游 HTTP 非 2xx 即使业务码为 0 也判失败并映射为 502", async () => {
    const record = await seedRecord("run-io-http-status");
    responses[GET_PROCESS_PATH] = () => ({
      status: 500,
      body: { code: 0, msg: "", data: { nodeResults: [nodeResult("Start", { input: "{}" })] } },
    });

    const response = await request(
      app,
      `/run-records/${EXECUTE_ID}/io?upstreamWorkflowId=${record.upstreamWorkflowId}`,
    );

    expect(response.status).toBe(502);
    expect((await readBody(response)).error?.code).toBe("UPSTREAM_REJECTED");
  });

  // 熔断打开时没有发出请求，与其它控制面端点同档为 503（可重试）。
  test("上游熔断打开时返回 503", async () => {
    const record = await seedRecord("run-io-circuit");
    responses[GET_PROCESS_PATH] = () => {
      throw new UpstreamCircuitOpenError(GET_PROCESS_PATH, 1_000);
    };

    const response = await request(
      app,
      `/run-records/${EXECUTE_ID}/io?upstreamWorkflowId=${record.upstreamWorkflowId}`,
    );

    expect(response.status).toBe(503);
    expect((await readBody(response)).error?.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  // 超时是可重试的独立一档（504）：与业务失败（502，上游明确拒绝）分开，用户看到的下一步动作不同。
  test("上游超时映射为 504", async () => {
    const record = await seedRecord("run-io-timeout");
    responses[GET_PROCESS_PATH] = () => {
      throw new UpstreamRequestError("UPSTREAM_TIMEOUT", "fixture timeout");
    };

    const response = await request(
      app,
      `/run-records/${EXECUTE_ID}/io?upstreamWorkflowId=${record.upstreamWorkflowId}`,
    );

    expect(response.status).toBe(504);
    expect((await readBody(response)).error?.code).toBe("UPSTREAM_TIMEOUT");
  });
});
