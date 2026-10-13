import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { resetPlatformAccountLocaleForTests } from "../server/services/platform-account-locale";
import {
  getUpstreamSession,
  getUpstreamSessionStatus,
  UpstreamSessionUnavailableError,
} from "../server/services/upstream-session";
import { initializeWorkflowV2ModuleConfig } from "../server/testing";

/**
 * 平台上游会话（1B）的行为契约测试。
 *
 * 上游一律用 `Bun.serve` 起的本地假实例，不依赖真实上游：真实实例的响应形态已由契约快照固化
 * （`docs/design/2026-09-29-workflow-v2-upstream-contract-snapshot.md` §2.1），本文件只验证我方行为。
 *
 * 「模块加载期不发请求」由结构保证：本文件静态导入 `upstream-session` 时应用基础设施尚未初始化，
 * 任何加载期出站都会在 `getWorkflowV2Config()` 处直接抛错、整个文件失败；因此用例只断言「取单例与
 * 未调用前请求数为 0」。
 *
 * 本文件所有凭据都是明显假的 fixture（保留域邮箱 + 随机后缀标记），不使用也不记录真实凭据。
 */

const TEST_EMAIL = "workflow-v2-session@example.invalid";
const TEST_PASSWORD = "fixture-password-4c1f-not-a-secret";
const COOKIE_VALUE = "session-key-fixture-9a27";
const SECOND_COOKIE_VALUE = "session-key-fixture-5b13";
const UPSTREAM_USER_ID = "upstream-user-fixture-10086";

/** 上游不可达用例的地址：本机 1 号端口没有监听者，连接会被立即拒绝。 */
const UNREACHABLE_BASE_URL = "http://127.0.0.1:1";

/**
 * 平台账号 locale 校正的读取端点。
 *
 * 它搭在 `ensureCookie` 上（见 `platform-account-locale`），但那是**另一个关注点**、有自己的用例文件；本文件
 * 断言的是会话模块自己发了几次、发了什么，因此假上游在这里就地把它应答成「已是 zh-CN」（只读、无写），且不记
 * 进请求记录——计数与下标因此与会话链路一一对应。
 */
const LOCALE_PROBE_PATH = "/api/passport/account/info/v2/";

/** 假上游记录的一条请求（凭据只在请求体，这里只留形状相关字段）。 */
interface FakeRequest {
  method: string;
  /** 路径 + 查询串，不含 host。 */
  path: string;
  cookie: string | null;
  contentType: string | null;
  bodyText: string | null;
}

/**
 * 假上游：**整个文件共用一个**实例（`beforeAll` 起、`afterAll` 停），用例只替换响应处理器。
 *
 * 为什么不是「每个用例起停一个服务器」：`Bun.serve({ port: 0 })` 反复释放/重绑端口时，进程内 fetch 的连接池
 * 可能仍持有指向刚被停掉的服务端的 keep-alive 连接——复用该连接会得到网络错误；端口若在窗口期被机器上其它
 * 进程占用，还会收到对方的 401/404。这类失败与被测行为无关，实测在 20~200 次运行中偶发 1 次。
 * 单实例把端口 churn 降到每文件一次；用例之间只重置请求记录与处理器。
 */
let upstreamServer: ReturnType<typeof Bun.serve> | null = null;

/** 假上游收到的请求（当前用例的）；`setup()` 就地清空，保持引用稳定。 */
const upstreamRequests: FakeRequest[] = [];

/** 当前用例的响应处理器；未设置就发请求时立刻以 500 暴露，而不是静默返回空响应。 */
let upstreamHandler: (request: FakeRequest) => Response | Promise<Response> = () =>
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
      if (url.pathname === LOCALE_PROBE_PATH) {
        return new Response(JSON.stringify({ code: 0, data: { locale: "zh-CN" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const bodyText = request.method === "POST" ? await request.text() : null;
      const recorded: FakeRequest = {
        method: request.method,
        path: `${url.pathname}${url.search}`,
        cookie: request.headers.get("cookie"),
        contentType: request.headers.get("content-type"),
        bodyText,
      };
      upstreamRequests.push(recorded);
      return upstreamHandler(recorded);
    },
  });
});

afterAll(() => {
  upstreamServer?.stop(true);
  upstreamServer = null;
});

/** 正常登录响应；`Set-Cookie` 的 domain 带端口（上游实测形态，非法 domain 正是手工解析的理由）。 */
function loginOk(cookieValue: string = COOKIE_VALUE): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data: { user_id_str: UPSTREAM_USER_ID } }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `session_key=${cookieValue}; max-age=2592000; domain=127.0.0.1:18080; path=/; HttpOnly; SameSite`,
    },
  });
}

/** 上游信封响应。 */
function envelope(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("upstream-session", () => {
  /**
   * 把模块配置指向共用的假上游、换上本用例的处理器，并清空请求记录；每个用例都从「无会话」开始。
   *
   * 返回 `{ requests }` 的是同一个数组引用（`setup()` 就地清空），用例可安全地持有它做断言。
   */
  function setup(handler: (request: FakeRequest) => Response | Promise<Response>): { requests: FakeRequest[] } {
    upstreamHandler = handler;
    upstreamRequests.length = 0;
    initializeWorkflowV2ModuleConfig({
      upstreamBaseUrl: upstreamBaseUrl(),
      accountEmail: TEST_EMAIL,
      accountPassword: TEST_PASSWORD,
    });
    // 会话是进程单例，用例之间必须显式作废，否则会拿到上一个用例的会话值。
    getUpstreamSession().invalidate();
    // locale 校正的结论同样是进程级记忆（成功即记住）：不复位就会让本文件第一个用例与后续用例的出站次数不同。
    resetPlatformAccountLocaleForTests();
    return { requests: upstreamRequests };
  }

  afterEach(() => {
    resetAllStubs();
    upstreamHandler = () => new Response("用例未设置假上游处理器", { status: 500 });
  });

  // 惰性登录：取单例不产生任何出站请求，首次 ensureCookie 才登录，且登录必须是 POST + JSON + 固定路径。
  test("首次 ensureCookie 才登录，登录请求为 POST + application/json", async () => {
    const started = setup(() => loginOk());

    getUpstreamSession();
    expect(started.requests).toHaveLength(0);

    const cookie = await getUpstreamSession().ensureCookie();

    expect(cookie).toBe(`session_key=${COOKIE_VALUE}`);
    expect(started.requests).toHaveLength(1);
    expect(started.requests[0].method).toBe("POST");
    expect(started.requests[0].path).toBe("/api/passport/web/email/login/");
    expect(started.requests[0].contentType).toBe("application/json");
  });

  // 会话值来自 Set-Cookie 手工解析：domain 带端口的非法 Cookie 也必须被采信（cookie jar 会整条拒收）。
  test("从带端口的非法 domain Set-Cookie 里手工解析会话值并记录声明有效期", async () => {
    setup(() => loginOk());

    await getUpstreamSession().ensureCookie();
    const status = getUpstreamSessionStatus();

    expect(status.ready).toBe(true);
    expect(status.platformUserId).toBe(UPSTREAM_USER_ID);
    expect(status.expiresAt).not.toBeNull();
    expect(new Date(status.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now());
    // 状态快照可进面向控制台的响应：会话值、邮箱、密码一律不得出现在里面。
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(COOKIE_VALUE);
    expect(serialized).not.toContain(TEST_EMAIL);
    expect(serialized).not.toContain(TEST_PASSWORD);
  });

  // 单飞：上游是单会话账号，并发登录会互相踢键，因此并发 ensureCookie 必须只触发一次登录。
  test("并发 5 次 ensureCookie 只发一次登录请求且共享同一会话值", async () => {
    const started = setup(async () => {
      await Bun.sleep(20);
      return loginOk();
    });

    const cookies = await Promise.all(Array.from({ length: 5 }, () => getUpstreamSession().ensureCookie()));

    expect(started.requests).toHaveLength(1);
    expect(new Set(cookies).size).toBe(1);
    expect(cookies[0]).toBe(`session_key=${COOKIE_VALUE}`);
  });

  // 失败不粘住：一次登录被拒不能让后续调用永久拿到同一个失败，下一次调用必须重新发起登录并成功。
  test("登录被拒后重新尝试可成功，失败状态不被缓存", async () => {
    let attempt = 0;
    const started = setup(() => {
      attempt += 1;
      return attempt === 1 ? envelope({ code: 700000003, msg: "authentication failed" }) : loginOk();
    });

    await expect(getUpstreamSession().ensureCookie()).rejects.toBeInstanceOf(UpstreamSessionUnavailableError);

    const cookie = await getUpstreamSession().ensureCookie();
    expect(cookie).toBe(`session_key=${COOKIE_VALUE}`);
    expect(started.requests).toHaveLength(2);
  });

  // 登录被拒的错误带诊断上下文（HTTP 状态与业务码），但绝不含凭据：错误消息可能被日志与响应消费。
  test("登录被拒的错误消息含业务码且不含凭据与邮箱", async () => {
    setup(() => envelope({ code: 700000003, msg: "authentication failed" }));

    let message = "";
    try {
      await getUpstreamSession().ensureCookie();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("code=700000003");
    expect(message).not.toContain(TEST_PASSWORD);
    expect(message).not.toContain(TEST_EMAIL);
    expect(message).not.toContain(COOKIE_VALUE);
  });

  // 登录响应缺 Set-Cookie 必须显式失败（不能把「没拿到会话」当成已登录），且消息只带 HTTP 状态。
  test("登录响应缺少 session_key 时抛出错误且不含凭据", async () => {
    setup(() => envelope({ code: 0, msg: "success", data: { user_id_str: UPSTREAM_USER_ID } }));

    let message = "";
    try {
      await getUpstreamSession().ensureCookie();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("session_key");
    expect(message).not.toContain(TEST_PASSWORD);
    expect(message).not.toContain(TEST_EMAIL);
  });

  // 上游不可达要归类为网络失败（而非「被拒」）：部署排查时两者的处置完全不同。
  test("上游不可达时抛出网络类错误且不含凭据", async () => {
    // 用「配置指向无人监听的端口」代替「停掉假上游」：共用的假上游要留给文件内其它用例。
    initializeWorkflowV2ModuleConfig({
      upstreamBaseUrl: UNREACHABLE_BASE_URL,
      accountEmail: TEST_EMAIL,
      accountPassword: TEST_PASSWORD,
    });
    getUpstreamSession().invalidate();

    let error: unknown = null;
    try {
      await getUpstreamSession().ensureCookie();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UpstreamSessionUnavailableError);
    expect((error as UpstreamSessionUnavailableError).reason).toBe("network");
    expect((error as Error).message).not.toContain(TEST_PASSWORD);
    expect((error as Error).message).not.toContain(TEST_EMAIL);
  });

  // invalidate 是失效广播的落点：丢弃会话后状态回到未就绪，下一次 ensureCookie 必须重新登录。
  test("invalidate 丢弃会话后下一次 ensureCookie 重新登录", async () => {
    let loginCount = 0;
    const started = setup(() => {
      loginCount += 1;
      return loginOk(loginCount === 1 ? COOKIE_VALUE : SECOND_COOKIE_VALUE);
    });

    const first = await getUpstreamSession().ensureCookie();
    getUpstreamSession().invalidate();

    expect(getUpstreamSessionStatus().ready).toBe(false);
    const second = await getUpstreamSession().ensureCookie();

    expect(first).toBe(`session_key=${COOKIE_VALUE}`);
    expect(second).toBe(`session_key=${SECOND_COOKIE_VALUE}`);
    expect(started.requests).toHaveLength(2);
  });

  // 探活不产生登录副作用：没有会话时直接判定不可用，一次上游请求都不发。
  test("probe 在没有会话时返回 false 且不请求上游", async () => {
    const started = setup(() => loginOk());

    expect(await getUpstreamSession().probe()).toBe(false);
    expect(started.requests).toHaveLength(0);
    expect(getUpstreamSessionStatus().lastProbeOk).toBe(false);
  });

  // 探活用最低成本接口验证会话：请求必须带上会话值，成功时返回 true 且不重登。
  test("probe 携带会话请求 space/list，成功返回 true 且不重登", async () => {
    const started = setup((request) =>
      request.path === "/api/passport/web/email/login/"
        ? loginOk()
        : envelope({ code: 0, data: { bot_space_list: [] } }),
    );

    await getUpstreamSession().ensureCookie();
    expect(await getUpstreamSession().probe()).toBe(true);

    expect(started.requests).toHaveLength(2);
    expect(started.requests[1].method).toBe("POST");
    expect(started.requests[1].path).toBe("/api/playground_api/space/list");
    expect(started.requests[1].cookie).toBe(`session_key=${COOKIE_VALUE}`);
    expect(getUpstreamSessionStatus().lastProbeOk).toBe(true);
    // 会话刚被验证过，控制台不应再看到失败标签。
    expect(getUpstreamSessionStatus().lastErrorCode).toBeNull();
  });

  // 探活命中鉴权失败码：判定不可用并作废会话（让下次调用单飞重登），但探活自身不得触发重登。
  test("probe 命中 700012006 时返回 false、作废会话且不触发重登", async () => {
    const started = setup((request) =>
      request.path === "/api/passport/web/email/login/"
        ? loginOk()
        : envelope({ code: 700012006, msg: "authentication failed: session not exist" }),
    );

    await getUpstreamSession().ensureCookie();
    expect(await getUpstreamSession().probe()).toBe(false);

    expect(getUpstreamSessionStatus().ready).toBe(false);
    // 探活失败要留下原因标签，否则控制台只能看到「已降级」而不知为何（会话被外部踢键属常见情形）。
    expect(getUpstreamSessionStatus().lastErrorCode).toBe("code=700012006");
    // 两次请求：登录 + 探活；探活没有引发第二次登录。
    expect(started.requests).toHaveLength(2);
  });

  // 探活遇上游 panic（777777775）只报不可用，不作废会话：该码是上游参数/内部问题，不代表会话失效。
  test("probe 遇上游 panic 码时返回 false 但保留会话", async () => {
    const started = setup((request) =>
      request.path === "/api/passport/web/email/login/"
        ? loginOk()
        : envelope({ code: 777777775, msg: "Workflow operation failure: panic" }),
    );

    await getUpstreamSession().ensureCookie();
    expect(await getUpstreamSession().probe()).toBe(false);

    expect(getUpstreamSessionStatus().ready).toBe(true);
    expect(started.requests).toHaveLength(2);
  });
});
