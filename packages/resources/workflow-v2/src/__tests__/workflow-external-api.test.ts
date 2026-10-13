// 对外触发面（`POST /api/workflow-v2/workflows/:id/run`）的行为契约。
//
// 这条端点是「外部系统触发工作流运行」的唯一入口，重点断言六件事：
// ① 路由挂在 `/api/workflow-v2` 前缀下且带宿主的认证守卫（同一份实例），未认证 401；
// ② 归属：跨组织与不存在**同形 404**（不泄漏存在性），且失败发生在触达上游之前；
// ③ 透传口径：`:id` 是本地主键，服务端把它换成上游 workflow ID 后调 `POST /v1/workflow/run`；
//    `parameters` 归一化成 JSON 字符串、`isAsync` 映射 `is_async`、`ext` 只透传受控字段；
// ④ 响应归一化为 `/api/*` 的域形状（字段缺失为 null，不省略键），**不**原样回传上游信封；
// ⑤ 上游业务码映射成平台稳定错误码（未发布 409、参数不合法 422、其余 502），且不泄漏上游 `msg`；
// ⑥ 限流按调用方身份计数（429 + `Retry-After`），审计只落身份与结果字段（不含入参原文）。
//
// 夹具（数据库句柄、守卫与上游替身）复用同目录 `helpers/console-plane-harness.ts`；无数据库时整组跳过。

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { initializeTestApplicationInfrastructure, readJson, resetAllStubs } from "@fenix/platform-sdk/testing";
import { Elysia } from "elysia";
import type { WorkflowV2ModuleConfigInput } from "../server/config";
import { createApiWorkflowV2Routes } from "../server/routes/api/workflows";
import type { ApiChannelReleaseOutcome } from "../server/services/api-channel-release";
import { WORKFLOW_AUDIT_ACTIONS } from "../server/services/audit-trail";
import type { UpstreamCallResult } from "../server/services/upstream-client";
import { createWorkflowV2ModuleConfig } from "../server/testing";
import {
  cleanupTestRows,
  closeTestPool,
  createStubAuthGuard,
  createUpstreamStub,
  database,
  databaseReachable,
  jsonInit,
  ORG_A,
  ORG_B,
  OWNER_ID,
  readAuditRows,
  request,
  seedRecord,
  sentBody,
  upstreamFail,
  upstreamOk,
} from "./helpers/console-plane-harness";

type Responses = Record<string, () => UpstreamCallResult | Promise<UpstreamCallResult>>;

/** 对外运行端点（上游 OpenAPI 面）。 */
const RUN_PATH = "/v1/workflow/run";

/** `/api/*` 的响应体形状（成功是域形状，失败是 `{ error: { code, message } }`）。 */
interface ApiBody {
  executeId?: string | null;
  data?: string | null;
  token?: number | null;
  cost?: string | null;
  debugUrl?: string | null;
  error?: { code: string; message: string };
}

const readApiBody = async (response: Response): Promise<ApiBody> => (await readJson(response)) as ApiBody;

/** 装配被测应用：数据库句柄 + 模块配置（限流阈值等经 overrides 覆盖；用例要压到 1 才驱动 429）。 */
function installApp(overrides: Partial<WorkflowV2ModuleConfigInput> = {}): void {
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    database: database(),
    moduleConfigs: { "workflow-v2": createWorkflowV2ModuleConfig(overrides) },
  });
}

/** 自愈端口的缺省替身：本次自愈未完成（真实现会打上游，用例一律注入，绝不触达真实上游）。 */
const releaseUnavailable = async (): Promise<ApiChannelReleaseOutcome> => ({ status: "unavailable" });

function createExternalApiApp(
  guard: ReturnType<typeof createStubAuthGuard>,
  upstream: ReturnType<typeof createUpstreamStub>,
  release: (input: {
    upstreamWorkflowId: string;
    appId: string;
  }) => Promise<ApiChannelReleaseOutcome> = releaseUnavailable,
) {
  return new Elysia().use(
    createApiWorkflowV2Routes(
      { authGuardPlugin: guard.plugin },
      { callUpstreamOpenApi: upstream.call, ensureApiChannelRelease: release },
    ),
  );
}

// 认证与路由存在性：不依赖数据库（守卫在配置读取与查询之前），因此单独成组、不随数据库跳过。
describe("对外触发面挂在 /api/workflow-v2 前缀下", () => {
  // 未认证时守卫不写 `store.authContext`，路由必须回 401 而不是 500/422——顺带证明这条路径确实注册在
  // 该前缀下（宿主装配面的槽位断言在 `apps/server` 侧）。
  test("未认证时返回 401", async () => {
    const guard = createStubAuthGuard();
    const app = createExternalApiApp(
      guard,
      createUpstreamStub({
        [RUN_PATH]: () => {
          throw new Error("未认证的请求不应触达上游");
        },
      }),
    );

    const response = await request(app, `/api/workflow-v2/workflows/${crypto.randomUUID()}/run`, jsonInit("POST", {}));
    const body = await readApiBody(response);

    expect(response.status).toBe(401);
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });
});

describe.skipIf(!databaseReachable)("对外触发运行（真实 Postgres + 上游替身）", () => {
  const guard = createStubAuthGuard();
  let responses: Responses;
  let upstream: ReturnType<typeof createUpstreamStub>;
  let app: Elysia;

  beforeEach(async () => {
    installApp();
    responses = {};
    upstream = createUpstreamStub(responses);
    app = createExternalApiApp(guard, upstream);
    guard.setActor({ organizationId: ORG_A, userId: OWNER_ID });
  });

  afterAll(async () => {
    guard.setActor(null);
    await cleanupTestRows();
    await closeTestPool();
  });

  // 同步成功路径：上游信封被归一化成域形状（五枚键齐全、缺失为 null），请求体里的 `workflow_id` 由服务端
  // 按本地主键解析——调用方给的是本地 ID，上游 ID 不出现在请求参数里。
  test("同步运行成功时归一化上游结果并注入上游 workflow ID", async () => {
    const record = await seedRecord("run-sync");
    responses[RUN_PATH] = () =>
      upstreamOk({
        execute_id: "6900000000000000001",
        data: '{"output":"hello"}',
        token: 7,
        cost: "0.01000",
        debug_url: "http://127.0.0.1:18080/work_flow?execute_id=6900000000000000001",
      });

    const response = await request(app, `/api/workflow-v2/workflows/${record.id}/run`, jsonInit("POST", {}));
    const body = await readApiBody(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      executeId: "6900000000000000001",
      data: '{"output":"hello"}',
      token: 7,
      cost: "0.01000",
      debugUrl: "http://127.0.0.1:18080/work_flow?execute_id=6900000000000000001",
    });
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.path).toBe(RUN_PATH);
    const sent = sentBody(upstream.calls, 0);
    expect(sent.workflow_id).toBe(record.upstreamWorkflowId);
    expect(sent.is_async).toBe(false);
    // 未提供参数时不下发 `parameters`（上游把它当可选项），`ext` 恒为对象（上游类型是 map）。
    expect("parameters" in sent).toBe(false);
    expect(sent.ext).toEqual({});
  });

  // 异步与参数透传：对象形态的 `parameters` 归一化成 JSON 字符串，`ext` 只带受控的 `user_id`；
  // 异步结果没有 `data`，因此该键为 null 而不是被省略。
  test("异步运行透传参数与受控 ext，缺省结果为 null", async () => {
    const record = await seedRecord("run-async");
    responses[RUN_PATH] = () => upstreamOk({ execute_id: "6900000000000000002", debug_url: "http://debug/1" });

    const response = await request(
      app,
      `/api/workflow-v2/workflows/${record.id}/run`,
      jsonInit("POST", { parameters: { input: "hello" }, isAsync: true, ext: { user_id: "runtime-user-1" } }),
    );
    const body = await readApiBody(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      executeId: "6900000000000000002",
      data: null,
      token: null,
      cost: null,
      debugUrl: "http://debug/1",
    });
    const sent = sentBody(upstream.calls, 0);
    expect(sent.parameters).toBe('{"input":"hello"}');
    expect(sent.is_async).toBe(true);
    expect(sent.ext).toEqual({ user_id: "runtime-user-1" });
  });

  // 参数在本地先判一次（JSON 对象或能解析成对象的 JSON 字符串）：必然失败的请求不打到上游，
  // 调用方拿到 422 而不是等一次上游拒绝。
  test("参数非法时本地拒绝且不触达上游", async () => {
    const record = await seedRecord("run-bad-params");

    for (const parameters of ["not-json", "[1,2]", '"scalar"']) {
      const response = await request(
        app,
        `/api/workflow-v2/workflows/${record.id}/run`,
        jsonInit("POST", { parameters }),
      );
      expect(response.status).toBe(422);
      expect((await readApiBody(response)).error?.code).toBe("INVALID_PARAMETERS");
    }
    expect(upstream.calls).toHaveLength(0);
  });

  // 上游业务码 != 0 映射成平台稳定错误码：未发布与参数不合法是调用方能据此行动的两档，其余归入通用拒绝，
  // 且上游 `msg`（含 panic 的 Go 堆栈）绝不进入响应。
  test("上游业务失败映射稳定错误码且不泄漏上游文案", async () => {
    const record = await seedRecord("run-upstream-fail");
    const cases: Array<{ code: number; status: number; platformCode: string }> = [
      { code: 6031, status: 409, platformCode: "WORKFLOW_NOT_PUBLISHED" },
      { code: 4000, status: 422, platformCode: "INVALID_PARAMETERS" },
      // 当前发布版本未登记到 API 渠道（上游 777777778）：可行动的冲突，不是「上游崩了」。
      { code: 777777778, status: 409, platformCode: "WORKFLOW_NOT_REGISTERED_TO_API_CHANNEL" },
      { code: 777777775, status: 502, platformCode: "UPSTREAM_REJECTED" },
    ];

    for (const item of cases) {
      responses[RUN_PATH] = () => upstreamFail(item.code, "internal stack trace /Users/agent/pkg/run.go:42");
      const response = await request(app, `/api/workflow-v2/workflows/${record.id}/run`, jsonInit("POST", {}));
      const body = await readApiBody(response);

      expect(response.status).toBe(item.status);
      expect(body.error?.code).toBe(item.platformCode);
      expect(body.error?.message).not.toContain("run.go");
    }

    // 四次上游拒绝各留一条审计（result 统一是「上游活着但拒绝」），且不记录入参原文。
    const rows = await readAuditRows(ORG_A, WORKFLOW_AUDIT_ACTIONS.runExternal);
    expect(rows.filter((row) => row.upstreamWorkflowId === record.upstreamWorkflowId).map((row) => row.result)).toEqual(
      ["upstream_rejected", "upstream_rejected", "upstream_rejected", "upstream_rejected"],
    );
  });

  // 缺渠道登记（777777778）时先做一次自愈再重试**一次**：登记是平台侧的前置条件，不该让调用方吃一次白跑的失败。
  test("缺 API 渠道登记时自愈后重试一次并返回成功", async () => {
    const record = await seedRecord("run-self-heal");
    const releases: Array<{ upstreamWorkflowId: string; appId: string }> = [];
    let runs = 0;
    app = createExternalApiApp(guard, upstream, async (input) => {
      releases.push(input);
      return { status: "released", version: "v0.0.5" };
    });
    responses[RUN_PATH] = () => {
      runs += 1;
      return runs === 1
        ? upstreamFail(777777778, "Service Internal Error")
        : upstreamOk({ execute_id: "6900000000000000009" });
    };

    const response = await request(
      app,
      `/api/workflow-v2/workflows/${record.id}/run`,
      jsonInit("POST", { isAsync: true, app_id: "client-supplied-app", project_id: "client-supplied-app" }),
    );

    expect(response.status).toBe(200);
    expect((await readApiBody(response)).executeId).toBe("6900000000000000009");
    expect(runs).toBe(2);
    // 自愈对象取自本地注册表（按组织谓词解析过的行），请求体里的同名客户端字段一律不参与。
    expect(releases).toEqual([{ upstreamWorkflowId: record.upstreamWorkflowId, appId: record.appId }]);
  });

  // 自愈没完成（冷却中、上游不可达、载体不可发布）时保留原始 409：只打一次上游，不把上游当重试靶子。
  test("自愈未完成时不重试并返回原始 409", async () => {
    const record = await seedRecord("run-self-heal-skipped");
    let runs = 0;
    app = createExternalApiApp(guard, upstream, async () => ({ status: "cooldown", retryAfterSeconds: 30 }));
    responses[RUN_PATH] = () => {
      runs += 1;
      return upstreamFail(777777778, "Service Internal Error");
    };

    const response = await request(app, `/api/workflow-v2/workflows/${record.id}/run`, jsonInit("POST", {}));

    expect(response.status).toBe(409);
    expect((await readApiBody(response)).error?.code).toBe("WORKFLOW_NOT_REGISTERED_TO_API_CHANNEL");
    expect(runs).toBe(1);
  });

  // 承载对象不是可发布的应用实体（历史 bot 载体）是**永久性**缺失：文案不得再暗示「稍后重试」，
  // 否则调用方会无意义地重试（实测该状态下补登记永远不会成功）。
  test("载体不可发布时文案指向管理员而不是重试", async () => {
    const record = await seedRecord("run-not-publishable");
    app = createExternalApiApp(guard, upstream, async () => ({ status: "app_not_publishable" }));
    responses[RUN_PATH] = () => upstreamFail(777777778, "Service Internal Error");

    const response = await request(app, `/api/workflow-v2/workflows/${record.id}/run`, jsonInit("POST", {}));
    const body = await readApiBody(response);

    expect(response.status).toBe(409);
    expect(body.error?.code).toBe("WORKFLOW_NOT_REGISTERED_TO_API_CHANNEL");
    expect(body.error?.message).toContain("请联系平台管理员");
    expect(body.error?.message).not.toContain("稍后重试");
  });

  // 归属：跨组织与不存在同形 404，且都在触达上游之前返回（404 不是上游给的，而是本地注册表给的）。
  test("跨组织与不存在的工作流一律 404 且不触达上游", async () => {
    const foreign = await seedRecord("run-foreign", null, ORG_B);
    const missing = crypto.randomUUID();

    for (const id of [foreign.id, missing]) {
      const response = await request(app, `/api/workflow-v2/workflows/${id}/run`, jsonInit("POST", {}));
      expect(response.status).toBe(404);
      expect((await readApiBody(response)).error?.code).toBe("WORKFLOW_NOT_FOUND");
    }
    expect(upstream.calls).toHaveLength(0);
  });

  // 非 UUID 的路径参数在边界上就被拒（422），不会带着非法值进数据库（那会变成一条 SQL 错误与 500）。
  test("非 UUID 的工作流 ID 在边界被拒且不触达上游", async () => {
    const response = await request(app, "/api/workflow-v2/workflows/not-a-uuid/run", jsonInit("POST", {}));

    expect(response.status).toBe(422);
    expect(upstream.calls).toHaveLength(0);
  });

  // 成功路径留审计：组织、调用者、上游 workflow ID 与结果都落库，入参与输出原文不落库。
  test("成功运行落审计流水", async () => {
    const record = await seedRecord("run-audit");
    responses[RUN_PATH] = () => upstreamOk({ execute_id: "6900000000000000003" });

    expect((await request(app, `/api/workflow-v2/workflows/${record.id}/run`, jsonInit("POST", {}))).status).toBe(200);

    expect(await readAuditRows(ORG_A, WORKFLOW_AUDIT_ACTIONS.runExternal)).toContainEqual({
      upstreamWorkflowId: record.upstreamWorkflowId,
      result: "ok",
      errorCode: null,
      actorUserId: OWNER_ID,
      requestId: null,
    });
  });

  // 限流按**调用方身份**计数（不是来源地址）：同一调用方第二次请求被拒并给出 `Retry-After`，换一个调用方
  // 仍有自己的配额（本用例里两个用户各自 1 次/分钟）。
  test("同一调用方超出配额返回 429 与 Retry-After", async () => {
    installApp({ apiRateLimitPerMinute: 1 });
    const limited = createExternalApiApp(guard, upstream);
    const record = await seedRecord("run-rate-limit");
    responses[RUN_PATH] = () => upstreamOk({ execute_id: "6900000000000000004" });
    guard.setActor({ organizationId: ORG_A, userId: `${OWNER_ID}-rl` });

    const first = await request(limited, `/api/workflow-v2/workflows/${record.id}/run`, jsonInit("POST", {}));
    const second = await request(limited, `/api/workflow-v2/workflows/${record.id}/run`, jsonInit("POST", {}));

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect((await readApiBody(second)).error?.code).toBe("RATE_LIMITED");
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // 被限流的那次没有打到上游（限流先于查询与运行）。
    expect(upstream.calls).toHaveLength(1);
  });
});
