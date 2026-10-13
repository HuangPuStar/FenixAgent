import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import {
  callUpstream,
  transportFailureKind,
  UPSTREAM_AUTH_FAILED_CODE,
  UPSTREAM_PANIC_CODE,
  UpstreamCircuitOpenError,
  UpstreamRequestError,
} from "../server/services/upstream-client";
import {
  resetUpstreamHealth,
  UPSTREAM_COOLDOWN_MS,
  UPSTREAM_FAILURE_THRESHOLD,
} from "../server/services/upstream-health";
import { getUpstreamSession, UpstreamSessionUnavailableError } from "../server/services/upstream-session";
import { initializeWorkflowV2ModuleConfig } from "../server/testing";

/**
 * 上游调用（1B）的行为契约测试。
 *
 * 上游一律用 `Bun.serve` 起的本地假实例：真实上游的响应形态（HTTP 200 + 业务码、panic 码、纯文本
 * 500）已由契约快照固化（`docs/design/2026-09-29-workflow-v2-upstream-contract-snapshot.md` §2.1），
 * 这里只验证「我方怎么发、失败怎么判、重放几次」。
 *
 * 重点覆盖 §9.1.1 第 1 条的修正：会话失效是 **HTTP 200 + code 700012006**，HTTP 401 只是「完全没带
 * Cookie」的特例；400 与 777777775 绝不算鉴权失败（否则参数错误会触发重登风暴）。
 *
 * 本文件所有凭据都是明显假的 fixture（保留域邮箱 + 标记串），不使用也不记录真实凭据。
 */

const TEST_EMAIL = "workflow-v2-client@example.invalid";
const TEST_PASSWORD = "fixture-password-7d24-not-a-secret";
const LOGIN_PATH = "/api/passport/web/email/login/";
/** 平台账号 locale 校正的两个端点（`platform-account-locale`）；与会话链路一起排除出业务调用。 */
const ACCOUNT_INFO_PATH = "/api/passport/account/info/v2/";
const UPDATE_PROFILE_PATH = "/api/user/update_profile";
/** 会话链路自身的出站：登录 + locale 校正的读与写。 */
const SESSION_LINK_PATHS: ReadonlySet<string> = new Set([LOGIN_PATH, ACCOUNT_INFO_PATH, UPDATE_PROFILE_PATH]);

/** 上游不可达用例的地址：本机 1 号端口没有监听者，连接会被立即拒绝。 */
const UNREACHABLE_BASE_URL = "http://127.0.0.1:1";

/** 假上游记录的一条请求。 */
interface FakeRequest {
  method: string;
  /** 路径 + 查询串，不含 host。 */
  path: string;
  cookie: string | null;
  contentType: string | null;
  bodyText: string | null;
}

/**
 * 假上游：**整个文件共用一个**实例（`beforeAll` 起、`afterAll` 停），用例只替换业务响应处理器。
 *
 * 为什么不是「每个用例起停一个服务器」：`Bun.serve({ port: 0 })` 反复释放/重绑端口时，进程内 fetch 的连接池
 * 可能仍持有指向刚被停掉的服务端的 keep-alive 连接——复用该连接会得到网络错误；端口若在窗口期被机器上其它
 * 进程占用，还会收到对方的 401/404。这类失败与被测行为无关，实测在 20~200 次运行中偶发 1 次。
 * 单实例把端口 churn 降到每文件一次；用例之间只重置请求记录与处理器。
 */
let upstreamServer: ReturnType<typeof Bun.serve> | null = null;

/** 假上游收到的请求（当前用例的）；`setup()` 就地清空，保持引用稳定。 */
const upstreamRequests: FakeRequest[] = [];

/** 假上游的登录次数：每次登录换一个新会话值，模拟上游单会话（重登即换键）；`setup()` 归零。 */
let loginCount = 0;

/** 当前用例的业务响应处理器（登录路径由文件内的调度器统一处理）。 */
let businessHandler: (request: FakeRequest) => Response | Promise<Response> = () =>
  new Response("用例未设置假上游处理器", { status: 500 });

/** 共用的假上游基址；未启动即使用说明用例顺序错了。 */
function upstreamBaseUrl(): string {
  if (upstreamServer === null) throw new Error("假上游尚未启动");
  return `http://127.0.0.1:${upstreamServer.port}`;
}

beforeAll(() => {
  upstreamServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const bodyText = request.method === "POST" ? await request.text() : null;
      const recorded: FakeRequest = {
        method: request.method,
        path: `${url.pathname}${url.search}`,
        cookie: request.headers.get("cookie"),
        contentType: request.headers.get("content-type"),
        bodyText,
      };
      upstreamRequests.push(recorded);
      if (recorded.path === LOGIN_PATH) {
        loginCount += 1;
        return loginOk(`session-key-${loginCount}`);
      }
      return businessHandler(recorded);
    },
  });
});

afterAll(() => {
  upstreamServer?.stop(true);
  upstreamServer = null;
});

/** 上游信封响应。 */
function envelope(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

/** 正常登录响应；`Set-Cookie` 的 domain 带端口（上游实测形态）。 */
function loginOk(cookieValue: string): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data: { user_id_str: "upstream-user-fixture" } }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `session_key=${cookieValue}; max-age=2592000; domain=127.0.0.1:18080; path=/; HttpOnly; SameSite`,
    },
  });
}

/**
 * 只保留业务调用，断言「发了几次、带了什么」时用它。
 *
 * 排除的是**会话链路自己的出站**：登录，以及拿到会话后顺带做的平台账号 locale 校正（`platform-account-locale`
 * 的读与写，见 `upstream-session.ensureCookie`）。它们由「第一次调用才建立会话」引入，与被测的业务调用无关。
 */
const businessRequests = (requests: FakeRequest[]): FakeRequest[] =>
  requests.filter((request) => !SESSION_LINK_PATHS.has(request.path.split("?")[0] ?? ""));

describe("upstream-client", () => {
  /**
   * 换上本用例的业务处理器、归零登录计数、清空请求记录，并把模块配置指向共用的假上游；
   * 每个用例都从「无会话」开始。
   *
   * 返回 `{ requests }` 的是同一个数组引用（`setup()` 就地清空），用例可安全地持有它做断言。
   */
  function setup(
    businessHandlerForTest: (request: FakeRequest) => Response | Promise<Response>,
    overrides: Partial<{ upstreamTimeoutMs: number }> = {},
  ): { requests: FakeRequest[] } {
    loginCount = 0;
    businessHandler = businessHandlerForTest;
    upstreamRequests.length = 0;
    initializeWorkflowV2ModuleConfig({
      upstreamBaseUrl: upstreamBaseUrl(),
      accountEmail: TEST_EMAIL,
      accountPassword: TEST_PASSWORD,
      ...overrides,
    });
    getUpstreamSession().invalidate();
    // 熔断是包内单例：不复位会让上一条用例（或上一个测试文件）的失败计数与冷却窗口泄漏进来。
    resetUpstreamHealth();
    return { requests: upstreamRequests };
  }

  afterEach(() => {
    resetAllStubs();
    businessHandler = () => new Response("用例未设置假上游处理器", { status: 500 });
  });

  // 冻结常量是对外契约：上游会话失效码与 panic 码必须与实测一致，改错会让失效判定整体失灵。
  test("导出的上游业务码与契约一致", () => {
    expect(UPSTREAM_AUTH_FAILED_CODE).toBe(700012006);
    expect(UPSTREAM_PANIC_CODE).toBe(777777775);
  });

  // 路径必须是 /api/ 前缀：其它前缀不是本模块的上游面，`..` 段会经 URL 归一化逃出 API 前缀。
  test("path 不以 /api/ 开头或含 .. 时拒绝调用且不发请求", async () => {
    const started = setup(() => envelope({ code: 0 }));

    await expect(callUpstream({ path: "/web/config" })).rejects.toBeInstanceOf(UpstreamRequestError);
    await expect(callUpstream({ path: "/api/../etc/passwd" })).rejects.toMatchObject({ code: "UPSTREAM_INVALID_PATH" });

    expect(started.requests).toHaveLength(0);
  });

  // POST 的请求形状是上游参数绑定的前提：固定 JSON 头、带上会话 Cookie、query 经编码拼进 URL。
  test("POST 调用固定 JSON 头并带上会话 Cookie，query 拼进查询串", async () => {
    const started = setup(() => envelope({ code: 0, data: { ok: true } }));

    const result = await callUpstream({
      path: "/api/workflow_api/canvas",
      query: { workflow_id: "wf-1", space_id: "space-1" },
      body: { space_id: "space-1" },
    });

    expect(result).toEqual({ status: 200, body: { code: 0, data: { ok: true } } });
    const business = businessRequests(started.requests);
    expect(business).toHaveLength(1);
    expect(business[0].method).toBe("POST");
    expect(business[0].path).toBe("/api/workflow_api/canvas?workflow_id=wf-1&space_id=space-1");
    expect(business[0].contentType).toBe("application/json");
    expect(business[0].cookie).toBe("session_key=session-key-1");
    expect(business[0].bodyText).toBe(JSON.stringify({ space_id: "space-1" }));
  });

  // GET 调用不得带请求体或 JSON 头（`get_process` 只挂 GET，多带 body 会改变上游语义）。
  test("GET 调用不写请求体与 Content-Type，查询参数按 URLSearchParams 编码", async () => {
    const started = setup(() => envelope({ code: 0, data: { executeStatus: 2 } }));

    const result = await callUpstream({
      path: "/api/workflow_api/get_process",
      method: "GET",
      query: { workflow_id: "wf 1", execute_id: "e&1" },
    });

    expect(result.status).toBe(200);
    const business = businessRequests(started.requests);
    expect(business[0].method).toBe("GET");
    expect(business[0].path).toBe("/api/workflow_api/get_process?workflow_id=wf+1&execute_id=e%261");
    expect(business[0].contentType).toBeNull();
    expect(business[0].bodyText).toBeNull();
  });

  // 会话失效的主路径（实测形态）：HTTP 200 + code 700012006 必须触发作废、重登与「只重放一次」。
  test("业务码 700012006 触发作废重登并重放一次原请求", async () => {
    const started = setup((request) =>
      request.cookie === "session_key=session-key-1"
        ? envelope({ code: UPSTREAM_AUTH_FAILED_CODE, msg: "authentication failed: session not exist" })
        : envelope({ code: 0, data: { ok: true } }),
    );

    const result = await callUpstream({ path: "/api/workflow_api/workflow_list", body: { space_id: "space-1" } });

    expect(result).toEqual({ status: 200, body: { code: 0, data: { ok: true } } });
    // 两次登录：首次登录 + 失效后的重登；两次业务请求：原请求 + 重放。
    expect(loginCount).toBe(2);
    const business = businessRequests(started.requests);
    expect(business).toHaveLength(2);
    expect(business[0].cookie).toBe("session_key=session-key-1");
    expect(business[1].cookie).toBe("session_key=session-key-2");
  });

  // HTTP 401 是「完全没有 Cookie」的形态，也属于会话失效，处置与业务码路径一致。
  test("HTTP 401 同样触发重登与重放一次", async () => {
    const started = setup((request) =>
      request.cookie === "session_key=session-key-1"
        ? envelope({ code: 401, msg: "missing session_key in cookie" }, 401)
        : envelope({ code: 0, data: { ok: true } }),
    );

    const result = await callUpstream({ path: "/api/workflow_api/canvas" });

    expect(result.status).toBe(200);
    expect(loginCount).toBe(2);
    expect(businessRequests(started.requests)).toHaveLength(2);
  });

  // 400（缺参数）不是鉴权失败：把它算进去会让每次参数错误都触发一次重登 + 重放。
  test("HTTP 400 不触发重登，响应原样返回", async () => {
    const started = setup(() => envelope({ code: 400, msg: "'size' field is a 'required' parameter" }, 400));

    const result = await callUpstream({ path: "/api/workflow_api/list_publish_workflow" });

    expect(result.status).toBe(400);
    expect(loginCount).toBe(1);
    expect(businessRequests(started.requests)).toHaveLength(1);
  });

  // 777777775 是上游 panic（参数缺失等的兜底），不是会话失效；响应体原样返回供透传面脱敏。
  test("上游 panic 码 777777775 不触发重登且响应体原样返回", async () => {
    const started = setup(() =>
      envelope({ code: UPSTREAM_PANIC_CODE, msg: "Workflow operation failure: panic\n\tgoroutine 1 [running]:" }),
    );

    const result = await callUpstream({ path: "/api/workflow_api/save", body: { workflow_id: "wf-1" } });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ code: UPSTREAM_PANIC_CODE });
    expect(loginCount).toBe(1);
    expect(businessRequests(started.requests)).toHaveLength(1);
  });

  // 重放仍被判失效说明问题不在会话：必须停止重试并抛会话不可用，交由调用方降级。
  test("重登后仍被判失效时抛出会话不可用错误且不再重放", async () => {
    const started = setup(() =>
      envelope({ code: UPSTREAM_AUTH_FAILED_CODE, msg: "authentication failed: access denied" }),
    );

    await expect(callUpstream({ path: "/api/workflow_api/canvas" })).rejects.toBeInstanceOf(
      UpstreamSessionUnavailableError,
    );

    expect(loginCount).toBe(2);
    expect(businessRequests(started.requests)).toHaveLength(2);
  });

  // 超时是调用侧错误而非上游响应：必须与网络错误区分开（前者可重试，后者要判上游可用性）。
  test("显式 timeoutMs 生效并抛出 UPSTREAM_TIMEOUT", async () => {
    setup(() => new Promise<Response>(() => {}));

    let error: unknown = null;
    try {
      await callUpstream({ path: "/api/workflow_api/canvas", timeoutMs: 30 });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UpstreamRequestError);
    expect((error as UpstreamRequestError).code).toBe("UPSTREAM_TIMEOUT");
    expect((error as Error).message).toContain("30ms");
  });

  // 未显式指定超时时取模块配置的 upstreamTimeoutMs：部署旋钮必须真的生效。
  test("未指定 timeoutMs 时取模块配置的 upstreamTimeoutMs", async () => {
    setup(() => new Promise<Response>(() => {}), { upstreamTimeoutMs: 40 });

    let error: unknown = null;
    try {
      await callUpstream({ path: "/api/workflow_api/canvas" });
    } catch (caught) {
      error = caught;
    }

    expect((error as UpstreamRequestError).code).toBe("UPSTREAM_TIMEOUT");
    expect((error as Error).message).toContain("40ms");
  });

  // 连接失败（上游不可达）归入网络错误：与超时分开，便于调用方判上游可用性。
  test("上游不可达时抛出 UPSTREAM_NETWORK_ERROR", async () => {
    setup(() => envelope({ code: 0 }));
    await getUpstreamSession().ensureCookie();

    // 迁移配置到无人监听的端口来模拟「上游不可达」：进程内会话仍然有效，因此走的是业务请求而非重登；
    // 共用的假上游要留给文件内其它用例，不能在这里停掉它。
    initializeWorkflowV2ModuleConfig({
      upstreamBaseUrl: UNREACHABLE_BASE_URL,
      accountEmail: TEST_EMAIL,
      accountPassword: TEST_PASSWORD,
    });

    let error: unknown = null;
    try {
      await callUpstream({ path: "/api/workflow_api/canvas" });
    } catch (caught) {
      error = caught;
    }

    expect((error as UpstreamRequestError).code).toBe("UPSTREAM_NETWORK_ERROR");
  });

  // 非 JSON 响应（上游 500 + 纯文本）按原文返回而不是抛异常：调用方需要据此判断上游形态。
  test("非 JSON 响应体按原始文本返回", async () => {
    setup(
      () =>
        new Response('panic: strconv.ParseInt: parsing "": invalid syntax', {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        }),
    );

    const result = await callUpstream({ path: "/api/workflow_api/node_type" });

    expect(result.status).toBe(500);
    expect(result.body).toBe('panic: strconv.ParseInt: parsing "": invalid syntax');
  });

  // 凭据不外泄：异常消息可能进日志与响应，绝不能带出会话值、邮箱或密码。
  test("重放失败的异常消息不含会话值、邮箱与密码", async () => {
    setup(() => envelope({ code: UPSTREAM_AUTH_FAILED_CODE }));

    let message = "";
    try {
      await callUpstream({ path: "/api/workflow_api/canvas" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("700012006");
    expect(message).not.toContain("session-key-");
    expect(message).not.toContain(TEST_PASSWORD);
    expect(message).not.toContain(TEST_EMAIL);
  });

  // ── 熔断（3C） ──

  describe("上游熔断", () => {
    /** 用例内的可控时钟：冷却窗口按毫秒推进，不必真的等 30s。 */
    let nowMs = 0;
    const advanceClock = (ms: number): void => {
      nowMs += ms;
    };
    /** 装上可控时钟；`callUpstream` 在调用时读取单例，因此改完再发请求即生效。 */
    const installClock = (): void => {
      nowMs = 0;
      resetUpstreamHealth(() => nowMs);
    };

    // 5xx 是上游「活着但服务不了」：连续达到阈值后必须停止发请求，而不是让每个请求都去撞一次故障上游。
    test("连续 5xx 达到阈值后打开熔断，后续调用不发上游请求", async () => {
      const started = setup(() => new Response("upstream down", { status: 500 }));
      installClock();

      for (let i = 0; i < UPSTREAM_FAILURE_THRESHOLD; i += 1) {
        expect((await callUpstream({ path: "/api/workflow_api/canvas" })).status).toBe(500);
      }
      const requestsBefore = businessRequests(started.requests).length;

      await expect(callUpstream({ path: "/api/workflow_api/canvas" })).rejects.toBeInstanceOf(UpstreamCircuitOpenError);

      // 「短路」的判据是**没有新请求**（含登录腿），不只是抛了对的错误。
      expect(businessRequests(started.requests)).toHaveLength(requestsBefore);
    });

    // 业务失败码（400、720701011 等）说明上游活着且正常应答：把它们算进熔断会让一次参数错误把整个上游判死。
    test("业务失败码不计入熔断", async () => {
      const started = setup(() => envelope({ code: 400, msg: "'size' field is a 'required' parameter" }, 400));
      installClock();

      const attempts = UPSTREAM_FAILURE_THRESHOLD * 3;
      for (let i = 0; i < attempts; i += 1) {
        expect((await callUpstream({ path: "/api/workflow_api/list_publish_workflow" })).status).toBe(400);
      }

      expect(businessRequests(started.requests)).toHaveLength(attempts);
      await expect(callUpstream({ path: "/api/workflow_api/list_publish_workflow" })).resolves.toMatchObject({
        status: 400,
      });
    });

    // 会话级失败（重登后仍被判失效）同样是上游不可用：累计到阈值后短路，且短路时连重登都不再尝试。
    test("会话级失败同样计入熔断", async () => {
      const started = setup(() => envelope({ code: UPSTREAM_AUTH_FAILED_CODE, msg: "session not exist" }));
      installClock();

      for (let i = 0; i < UPSTREAM_FAILURE_THRESHOLD; i += 1) {
        await expect(callUpstream({ path: "/api/workflow_api/canvas" })).rejects.toBeInstanceOf(
          UpstreamSessionUnavailableError,
        );
      }
      const requestsBefore = started.requests.length;

      await expect(callUpstream({ path: "/api/workflow_api/canvas" })).rejects.toBeInstanceOf(UpstreamCircuitOpenError);

      expect(started.requests).toHaveLength(requestsBefore);
    });

    // 冷却结束只放行一次探测；探测成功即恢复，后续调用不再受熔断限制（否则一次故障会永久降级）。
    test("冷却结束后半开探测，成功即恢复", async () => {
      let healthy = false;
      const started = setup(() =>
        healthy ? envelope({ code: 0, data: { ok: true } }) : new Response("down", { status: 500 }),
      );
      installClock();

      for (let i = 0; i < UPSTREAM_FAILURE_THRESHOLD; i += 1) await callUpstream({ path: "/api/workflow_api/canvas" });
      await expect(callUpstream({ path: "/api/workflow_api/canvas" })).rejects.toBeInstanceOf(UpstreamCircuitOpenError);

      healthy = true;
      advanceClock(UPSTREAM_COOLDOWN_MS);

      expect((await callUpstream({ path: "/api/workflow_api/canvas" })).status).toBe(200);
      expect((await callUpstream({ path: "/api/workflow_api/canvas" })).status).toBe(200);
      expect(businessRequests(started.requests)).toHaveLength(UPSTREAM_FAILURE_THRESHOLD + 2);
    });

    // 探测失败说明上游仍未恢复：必须回到打开态并刷新冷却，不能因为「探测过一次」就继续放量。
    test("半开探测失败后重新打开", async () => {
      setup(() => new Response("down", { status: 500 }));
      installClock();

      for (let i = 0; i < UPSTREAM_FAILURE_THRESHOLD; i += 1) await callUpstream({ path: "/api/workflow_api/canvas" });
      advanceClock(UPSTREAM_COOLDOWN_MS);

      expect((await callUpstream({ path: "/api/workflow_api/canvas" })).status).toBe(500);
      await expect(callUpstream({ path: "/api/workflow_api/canvas" })).rejects.toBeInstanceOf(UpstreamCircuitOpenError);
    });

    // 分类是熔断计数的唯一入口：只有超时/网络/会话三类计入，我方入参错误与短路自身都不判上游健康。
    test("失败分类只认传输/会话级失败", () => {
      expect(transportFailureKind(new UpstreamRequestError("UPSTREAM_TIMEOUT", "x"))).toBe("timeout");
      expect(transportFailureKind(new UpstreamRequestError("UPSTREAM_NETWORK_ERROR", "x"))).toBe("network");
      expect(transportFailureKind(new UpstreamSessionUnavailableError("rejected", "x"))).toBe("session");
      expect(transportFailureKind(new UpstreamRequestError("UPSTREAM_INVALID_PATH", "x"))).toBeNull();
      expect(transportFailureKind(new UpstreamCircuitOpenError("/api/x", 10))).toBeNull();
      expect(transportFailureKind(new Error("boom"))).toBeNull();
    });
  });
});
