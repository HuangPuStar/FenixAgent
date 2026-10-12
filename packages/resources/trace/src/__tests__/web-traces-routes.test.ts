import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createDeterministicRcsSessionId } from "@fenix/chat-channel";
import { NotFoundError } from "@fenix/platform-sdk";
import { readJson } from "@fenix/platform-sdk/testing";
import type { EnvironmentOwnershipCheck, WebTraceRouteDependencies } from "../server/routes/dependencies";
import { createWebTraceRoutes, setTraceReadServiceForTests } from "../server/routes/web/traces";
import { LangfuseReadError } from "../server/services/langfuse-client";
import type { TraceReadService } from "../server/services/trace-read";
import { createStubSessionAuthGuardPlugin, type StubAuthContext } from "./guard-stubs";

/**
 * `/web/.../traces*` 路由的响应契约与失败映射。
 *
 * 覆盖范围刻意止于**路由自身**：归属校验顺序、rcsSessionId 的推导口径、错误码映射与响应形状。读取服务与
 * 上游客户端的正确性归 `trace-read.test.ts` 与 `langfuse-client.test.ts`；真实 DocManager / Langfuse 后端
 * 不参与——因此用例里恒有一个替身读取服务，`setTraceReadServiceForTests(null)` 在收尾恢复懒构造。
 *
 * 这里也是「密钥不出服务端」的端到端断言点：上游失败的原始消息（可能带请求上下文）不得进入响应体。
 */

const TEST_AUTH: StubAuthContext = { organizationId: "org-1", userId: "user-1" };
const ENVIRONMENT_ID = "env-1";
const INSTANCE_UID = "instance-uid-1";
const TRACE_ID = "trace-1";
const OBSERVATION_ID = "obs-1";

/** 上游失败消息里的「密钥材料」样本：任何响应体出现它即视为泄漏。 */
const SECRET_MARKER = "sk-lf-secret-must-not-leak";

/** 归属校验替身：默认通过；用例按需改成抛错，用来验证「校验在前、取数在后」。 */
const ownership: { impl: EnvironmentOwnershipCheck } = { impl: async () => ({}) };
let ownershipCalls: Array<{ environmentId: string; organizationId: string; userId: string }> = [];

/** 读取服务替身：只记录入参并返回固定值，路由之外的行为一律不参与。 */
function stubService(overrides: Partial<TraceReadService> = {}): TraceReadService {
  return {
    listSessionTraces: async () => ({ configured: false, acpSessionId: null, traces: [], page: 1, totalItems: 0 }),
    listTraceObservations: async () => ({ data: [], cursor: null }),
    getTraceObservation: async () => ({
      data: { id: OBSERVATION_ID, type: "SPAN", startTime: "2026-10-01T00:00:00.000Z" },
    }),
    ...overrides,
  };
}

let serviceCalls: unknown[] = [];

function dependencies(authContext: StubAuthContext | null = TEST_AUTH): WebTraceRouteDependencies {
  return {
    authGuardPlugin: createStubSessionAuthGuardPlugin(authContext),
    getOwnedEnvironment: (environmentId, organizationId, userId) => {
      ownershipCalls.push({ environmentId, organizationId, userId });
      return ownership.impl(environmentId, organizationId, userId);
    },
  };
}

// 认证守卫按插件名去重，两个实例分属两个独立 app 根：一个注入认证上下文，一个不注入。
const route = createWebTraceRoutes(dependencies());
/** 未认证实例：用于逐端点验证 `sessionAuth: true` 声明存在。 */
const anonymousRoute = createWebTraceRoutes(dependencies(null));

function tracesPath(suffix = "") {
  return `/agents/${ENVIRONMENT_ID}/sessions/${INSTANCE_UID}/traces${suffix}`;
}
function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}
function observationsPath(suffix = "") {
  return tracesPath(`/${TRACE_ID}/observations${suffix}`);
}

const originalConsoleError = console.error;

beforeEach(() => {
  usageReset();
  ownership.impl = async () => ({});
  setTraceReadServiceForTests(stubService());
  // 路由在 unauthorized 分支写服务端日志；用例静音它，避免测试输出被预期间谍污染。
  console.error = () => {};
});

afterEach(() => {
  setTraceReadServiceForTests(null);
  console.error = originalConsoleError;
  usageReset();
});

function usageReset() {
  ownershipCalls = [];
  serviceCalls = [];
}

describe("trace 路由鉴权", () => {
  // 三个端点都声明了 sessionAuth，未认证必须一律 401：漏一条声明即失败。
  test("未认证时全部端点返回 401", async () => {
    const cases = [tracesPath(), observationsPath(), `${observationsPath()}/${OBSERVATION_ID}`];
    for (const path of cases) {
      const response = await anonymousRoute.handle(new Request(`http://localhost${path}`));
      expect([path, response.status]).toEqual([path, 401]);
    }
  });

  // 未认证时不得触碰环境归属查询与读取服务：鉴权必须先于任何数据访问。
  test("未认证时不查询归属、不调用读取服务", async () => {
    await anonymousRoute.handle(new Request(`http://localhost${tracesPath()}`));
    expect(ownershipCalls).toEqual([]);
    expect(serviceCalls).toEqual([]);
  });
});

describe("trace 路由会话推导", () => {
  // rcsSessionId 必须由 environmentId + 认证用户 + 实例 uid 确定性算出，浏览器传来的 sessionId 只当实例 uid。
  test("rcsSessionId 按会话三要素确定性推导", async () => {
    setTraceReadServiceForTests(
      stubService({
        listSessionTraces: async (input) => {
          serviceCalls.push(input);
          return { configured: false, acpSessionId: null, traces: [], page: 1, totalItems: 0 };
        },
      }),
    );
    const first = await request(tracesPath());
    const second = await request(tracesPath());
    expect([first.status, second.status]).toEqual([200, 200]);
    const expected = createDeterministicRcsSessionId(ENVIRONMENT_ID, TEST_AUTH.userId, INSTANCE_UID);
    expect(serviceCalls).toHaveLength(2);
    expect(serviceCalls[0]).toMatchObject({ rcsSessionId: expected, page: 1, limit: 50 });
    expect((serviceCalls[1] as { rcsSessionId: string }).rcsSessionId).toBe(expected);
  });

  // 归属校验必须带认证上下文的组织与用户，且先于读取：越权与「会话不存在」不得在响应上被抹平。
  test("先校验 environment 归属再取数，越权时 404 且不调用读取服务", async () => {
    ownership.impl = async () => {
      throw new NotFoundError("Environment 不存在");
    };
    const response = await request(tracesPath());
    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Environment 不存在" },
    });
    expect(ownershipCalls).toEqual([
      { environmentId: ENVIRONMENT_ID, organizationId: TEST_AUTH.organizationId, userId: TEST_AUTH.userId },
    ]);
    expect(serviceCalls).toEqual([]);
  });

  // 查询参数按 schema 收窄并透传：翻页与 limit 由面板决定，服务端不得接受越界值。
  test("列表查询参数被校验并透传", async () => {
    setTraceReadServiceForTests(
      stubService({
        listSessionTraces: async (input) => {
          serviceCalls.push(input);
          return { configured: false, acpSessionId: null, traces: [], page: input.page, totalItems: 0 };
        },
      }),
    );
    expect((await request(tracesPath("?page=3&limit=100"))).status).toBe(200);
    expect(serviceCalls[0]).toMatchObject({ page: 3, limit: 100 });
    // limit 上限 100：越界必须在协议层被拒，而不是把超大 limit 转给上游。
    expect((await request(tracesPath("?limit=101"))).status).toBe(422);
    expect((await request(observationsPath("?limit=201"))).status).toBe(422);
  });

  // observations 的游标是不透明字符串，路由原样透传，不做解析或重写。
  test("observations 透传 traceId 与游标", async () => {
    setTraceReadServiceForTests(
      stubService({
        listTraceObservations: async (input) => {
          serviceCalls.push(input);
          return { data: [], cursor: "next-cursor" };
        },
      }),
    );
    const response = await request(observationsPath("?cursor=abc&limit=200"));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: { data: [], cursor: "next-cursor" } });
    expect(serviceCalls[0]).toEqual({
      rcsSessionId: createDeterministicRcsSessionId(ENVIRONMENT_ID, TEST_AUTH.userId, INSTANCE_UID),
      traceId: TRACE_ID,
      cursor: "abc",
      limit: 200,
    });
  });
});

describe("trace 路由响应契约", () => {
  // 未配置观测读取是部署状态而非故障：必须 200 + configured=false，面板据此走引导态。
  test("未配置观测读取时 200 且 configured=false", async () => {
    const response = await request(tracesPath());
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      success: true,
      data: { configured: false, acpSessionId: null, traces: [], page: 1, totalItems: 0 },
    });
  });

  // 已配置但尚未 session/new：acpSessionId 为 null 是正常态，与「没有 run」严格区分。
  test("无活跃 ACP 会话时返回 acpSessionId=null", async () => {
    setTraceReadServiceForTests(
      stubService({
        listSessionTraces: async () => ({ configured: true, acpSessionId: null, traces: [], page: 1, totalItems: 0 }),
      }),
    );
    expect(await readJson(await request(tracesPath()))).toEqual({
      success: true,
      data: { configured: true, acpSessionId: null, traces: [], page: 1, totalItems: 0 },
    });
  });

  // 单条 observation 的响应必须被 WebOkSchema 包裹，且详情响应整体照搬视图（含 startTime 强约束字段）。
  test("单条 observation 详情按 data 包裹返回", async () => {
    expect(await readJson(await request(`${observationsPath()}/${OBSERVATION_ID}`))).toEqual({
      success: true,
      data: { data: { id: OBSERVATION_ID, type: "SPAN", startTime: "2026-10-01T00:00:00.000Z" } },
    });
  });
});

describe("trace 路由失败映射", () => {
  const mappings: Array<[string, LangfuseReadError, number, string]> = [
    ["not_found", new LangfuseReadError("not_found", "上游 404"), 404, "NOT_FOUND"],
    [
      "unauthorized",
      new LangfuseReadError("unauthorized", `上游 401 ${SECRET_MARKER}`),
      502,
      "TRACE_BACKEND_UNAUTHORIZED",
    ],
    ["unreachable", new LangfuseReadError("unreachable", "连接被拒绝"), 503, "TRACE_BACKEND_UNREACHABLE"],
    ["upstream", new LangfuseReadError("upstream", "上游 500"), 502, "TRACE_BACKEND_ERROR"],
    ["invalid_response", new LangfuseReadError("invalid_response", "响应不是 JSON"), 502, "TRACE_BACKEND_ERROR"],
  ];

  // 五类上游失败各自映射到稳定的状态码与错误码，且上游消息、密钥材料都不进入响应体。
  for (const [kind, failure, status, code] of mappings) {
    test(`${kind} 映射为 ${status} ${code}`, async () => {
      setTraceReadServiceForTests(
        stubService({
          listSessionTraces: async () => {
            throw failure;
          },
        }),
      );
      const response = await request(tracesPath());
      const text = await response.text();
      expect([kind, response.status]).toEqual([kind, status]);
      expect(JSON.parse(text)).toEqual({
        success: false,
        error: { code, message: expect.any(String) },
      });
      expect(text).not.toContain(SECRET_MARKER);
    });
  }

  // 非预期异常必须继续冒泡（落到宿主全局错误处理器，最终 500），不得被本路由吞成 200 或冒充上游故障。
  // 响应文案的脱敏属宿主全局错误处理器（`apps/server/src/plugins/error-handler.ts`，用例见
  // `apps/server/src/__tests__/error-handler.test.ts`）：包内 app 没有该插件，故这里只钉「不是业务码」。
  test("未知异常不落入业务错误映射", async () => {
    setTraceReadServiceForTests(
      stubService({
        listSessionTraces: async () => {
          throw new Error(`unexpected ${SECRET_MARKER}`);
        },
      }),
    );
    const response = await request(tracesPath());
    expect(response.status).toBe(500);
    const text = await response.text();
    // Elysia 默认错误响应是纯文本：既不是成功信封，也不得贴上本模块的业务错误码。
    expect(text).not.toContain('"success":true');
    expect(text).not.toContain("TRACE_BACKEND_");
  });

  // 三条端点共用同一映射：observations 与单条详情同样按 503 上报不可达。
  test("observations 与详情端点共用失败映射", async () => {
    setTraceReadServiceForTests(
      stubService({
        listTraceObservations: async () => {
          throw new LangfuseReadError("unreachable", "连接超时");
        },
        getTraceObservation: async () => {
          throw new NotFoundError("观测记录不存在");
        },
      }),
    );
    expect(await readJson(await request(observationsPath()))).toEqual({
      success: false,
      error: { code: "TRACE_BACKEND_UNREACHABLE", message: "观测后端不可达" },
    });
    expect(await readJson(await request(`${observationsPath()}/${OBSERVATION_ID}`))).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "观测记录不存在" },
    });
  });
});

describe("trace 路由测试替身自检", () => {
  // 替身必须真的被路由消费：若 seam 失效（例如懒构造绕过替身），下面的断言会失败而非静默通过。
  test("路由确实使用注入的读取服务替身", async () => {
    const spy = mock(async () => ({ configured: false, acpSessionId: null, traces: [], page: 1, totalItems: 0 }));
    setTraceReadServiceForTests(stubService({ listSessionTraces: spy }));
    await request(tracesPath());
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
