// 平台账号 locale 校正（内嵌画布中英文案的根因修复）的行为测试。
//
// 上游用 `Bun.serve` 起的本地假实例（与 `platform-account-registration.test.ts` 同一套「进程级服务端 + 每轮重装
// 处理器」的写法，理由见该文件的 anchor 注释）：校正只认上游信封里的 `code` 与 `data.locale`，用替身无法覆盖
// 「读回来的是什么、发出去的是什么」这两件事。
//
// 本文件的断言集中在三处：**判据**（已是 zh-CN 时绝不发写请求）、**报文**（写请求的路径、请求体与 Cookie）、
// **降级**（失败不抛错、按进程记忆与冷却窗口不重复出站）。

import { afterEach, describe, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import {
  ensurePlatformAccountLocale,
  PLATFORM_ACCOUNT_LOCALE_ZH,
  resetPlatformAccountLocaleForTests,
} from "../server/services/platform-account-locale";
import { getUpstreamSession, resetUpstreamSessionForTests } from "../server/services/upstream-session";
import { initializeWorkflowV2ModuleConfig } from "../server/testing";

/** 上游端点（与上游源码逐字一致）。 */
const LOGIN_PATH = "/api/passport/web/email/login/";
const ACCOUNT_INFO_PATH = "/api/passport/account/info/v2/";
const UPDATE_PROFILE_PATH = "/api/user/update_profile";

/** 本用例持有的会话值；只在请求头里出现，不进日志与错误文案。 */
const COOKIE_HEADER = "session_key=session-key-locale-fixture";

/** 上游不可达用例的地址：本机 1 号端口没有监听者，连接会被立即拒绝。 */
const UNREACHABLE_BASE_URL = "http://127.0.0.1:1";

/** 假上游记录的一次请求；`cookie` 用来断言写请求带的是同一个会话，而不是别的凭据。 */
interface FakeRequest {
  path: string;
  cookie: string | null;
  body: Record<string, unknown>;
}

/**
 * 假上游与其处理器的进程级挂载点。
 *
 * 服务端只在进程内起一次（`--rerun-each N` 重跑时，每轮重建 `Bun.serve({ port: 0 })` 会命中上一轮刚释放的
 * 端口，而连接池仍持有指向已停止服务端的 keep-alive 连接，表现为整轮用例一起失败）；处理器每轮重装，让长驻
 * 服务端读到本轮的状态。
 */
const anchor = globalThis as typeof globalThis & {
  __wf2LocaleUpstream?: ReturnType<typeof Bun.serve>;
  __wf2LocaleUpstreamHandler?: (request: FakeRequest) => Response;
};

function upstreamServer(): ReturnType<typeof Bun.serve> {
  anchor.__wf2LocaleUpstream ??= Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const raw = request.method === "POST" ? await request.text() : "";
      let body: Record<string, unknown> = {};
      try {
        body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      const handler = anchor.__wf2LocaleUpstreamHandler;
      if (handler === undefined) return new Response("用例未装载假上游处理器", { status: 500 });
      return handler({ path: url.pathname, cookie: request.headers.get("cookie"), body });
    },
  });
  return anchor.__wf2LocaleUpstream;
}

const upstreamRequests: FakeRequest[] = [];

/** 假账号当前的语言偏好；`null` 模拟上游把 `locale` 字段整个缺席的账号。 */
let accountLocale: string | null = null;
/** 两个端点的响应覆盖（驱动读取失败 / 写入失败分支）；`null` 表示走上面的账号状态。 */
let infoOverride: (() => Response) | null = null;
let updateOverride: (() => Response) | null = null;

function envelope(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/** 上游在免 cookie 路径上登录，成功时经 `Set-Cookie` 下发会话（响应体不含凭据）。 */
function loginOk(): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data: { user_id_str: "upstream-user-locale" } }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `${COOKIE_HEADER}; max-age=2592000; path=/; HttpOnly`,
    },
  });
}

function handleUpstream(request: FakeRequest): Response {
  upstreamRequests.push(request);
  switch (request.path) {
    case LOGIN_PATH:
      return loginOk();
    case ACCOUNT_INFO_PATH:
      if (infoOverride !== null) return infoOverride();
      // 账号没有 locale 时上游整份字段缺席（`userDo2PassportTo` 只在非空时回填），这里照此建模。
      return envelope({
        code: 0,
        msg: "success",
        data: accountLocale === null ? {} : { locale: accountLocale },
      });
    case UPDATE_PROFILE_PATH:
      if (updateOverride !== null) return updateOverride();
      accountLocale = typeof request.body.locale === "string" ? request.body.locale : accountLocale;
      return envelope({ code: 0, msg: "success", data: {} });
    default:
      return new Response("not found", { status: 404 });
  }
}

// 每轮重跑都会重新求值模块作用域：把本轮（含本轮的请求记录与账号状态）的处理器装到进程级假上游上。
anchor.__wf2LocaleUpstreamHandler = handleUpstream;

/** 复位：会话与 locale 记忆都是进程级单例，不复位会让用例之间互相看见对方的结果。 */
function setup(options: { baseUrl?: string } = {}): FakeRequest[] {
  upstreamRequests.length = 0;
  accountLocale = null;
  infoOverride = null;
  updateOverride = null;
  resetAllStubs();
  resetUpstreamSessionForTests();
  resetPlatformAccountLocaleForTests();
  initializeWorkflowV2ModuleConfig({ upstreamBaseUrl: options.baseUrl ?? upstreamBaseUrl() });
  return upstreamRequests;
}

function upstreamBaseUrl(): string {
  return `http://127.0.0.1:${upstreamServer().port}`;
}

/** 取本次校正的结果；不用 `resolves` 是因为大多数用例还要断言结果类型。 */
async function ensure(): Promise<Awaited<ReturnType<typeof ensurePlatformAccountLocale>>> {
  return await ensurePlatformAccountLocale(COOKIE_HEADER);
}

describe("workflow-v2 平台账号 locale 校正", () => {
  afterEach(() => {
    resetAllStubs();
    resetPlatformAccountLocaleForTests();
    infoOverride = null;
    updateOverride = null;
  });

  // 账号已是 zh-CN 时只读一次，**不发写请求**——这是「幂等」的判据，也是常态路径的全部代价。
  test("已是 zh-CN 时只读一次，不发写请求", async () => {
    const requests = setup();
    accountLocale = PLATFORM_ACCOUNT_LOCALE_ZH;

    expect(await ensure()).toEqual({ kind: "already_zh" });
    expect(requests.map((item) => item.path)).toEqual([ACCOUNT_INFO_PATH]);
  });

  // 账号是 en-US 时改写一次：写请求发给 update_profile、带上同一会话，且请求体就是目标语言。
  test("账号为 en-US 时改写一次，请求体与 Cookie 正确", async () => {
    const requests = setup();
    accountLocale = "en-US";

    expect(await ensure()).toEqual({ kind: "updated" });
    expect(requests.map((item) => item.path)).toEqual([ACCOUNT_INFO_PATH, UPDATE_PROFILE_PATH]);
    expect(requests[1]?.body).toEqual({ locale: PLATFORM_ACCOUNT_LOCALE_ZH });
    expect(requests[1]?.cookie).toBe(COOKIE_HEADER);
  });

  // 账号没有 locale（上游字段缺席）时同样按「不是 zh-CN」改写，把这类账号一并带成中文。
  test("locale 字段缺席时同样改写为 zh-CN", async () => {
    const requests = setup();
    accountLocale = null;

    expect(await ensure()).toEqual({ kind: "updated" });
    expect(requests.map((item) => item.path)).toEqual([ACCOUNT_INFO_PATH, UPDATE_PROFILE_PATH]);
  });

  // 读不回来时按失败降级：不猜测未知值、也不发写请求（避免在鉴权失效等情况下多做一次无谓的写）。
  test("读取失败时降级为 failed 且不发写请求", async () => {
    const requests = setup();
    infoOverride = () => envelope({ code: 700012006, msg: "auth failed" });

    expect(await ensure()).toEqual({ kind: "failed", detail: "code=700012006" });
    expect(requests.map((item) => item.path)).toEqual([ACCOUNT_INFO_PATH]);
  });

  // 写失败同样是降级（画布继续英文），不抛错——调用方是会话获取，不能因它而失败。
  test("写入失败时降级为 failed 而不抛错", async () => {
    setup();
    accountLocale = "en-US";
    updateOverride = () => new Response("boom", { status: 500 });

    expect(await ensure()).toEqual({ kind: "failed", detail: "http=500" });
  });

  // 成功结果按进程记忆：第二次调用直接复用结论，不再出站（ensureCookie 每次上游请求都会调用它）。
  test("校正成功后按进程记忆，再次调用不再出站", async () => {
    const requests = setup();
    accountLocale = "en-US";

    expect(await ensure()).toEqual({ kind: "updated" });
    const requestsAfterFirst = requests.length;
    expect(requestsAfterFirst).toBe(2);

    expect(await ensure()).toEqual({ kind: "updated" });
    expect(requests).toHaveLength(requestsAfterFirst);
  });

  // 失败后进入冷却：下一次调用不出站也不想当然重试，避免上游故障时把每个上游请求放大成三次往返。
  test("失败后进入冷却窗口，再次调用不出站", async () => {
    const requests = setup();
    accountLocale = "en-US";
    updateOverride = () => envelope({ code: 700000003, msg: "invalid" });

    expect(await ensure()).toEqual({ kind: "failed", detail: "code=700000003" });
    const requestsAfterFailure = requests.length;

    expect(await ensure()).toEqual({ kind: "cooldown" });
    expect(requests).toHaveLength(requestsAfterFailure);
  });

  // 上游不可达时归为传输失败（network），且不把异常抛给会话获取。
  test("上游不可达时归为 network 失败而不抛错", async () => {
    setup({ baseUrl: UNREACHABLE_BASE_URL });

    expect(await ensure()).toEqual({ kind: "failed", detail: "network" });
  });

  // 接入点回归：会话获取（ensureCookie）拿到会话后会顺带校正 locale，且用的是自己刚拿到的那个会话。
  test("ensureCookie 拿到会话后顺带校正 locale", async () => {
    const requests = setup();
    accountLocale = "en-US";

    expect(await getUpstreamSession().ensureCookie()).toBe(COOKIE_HEADER);
    expect(requests.map((item) => item.path)).toEqual([LOGIN_PATH, ACCOUNT_INFO_PATH, UPDATE_PROFILE_PATH]);
    expect(requests[2]?.cookie).toBe(COOKIE_HEADER);
  });

  // 降级不阻塞会话：locale 端点全部 404 时 ensureCookie 仍返回可用会话（画布最多继续显示英文）。
  test("locale 端点不可用时 ensureCookie 仍返回会话", async () => {
    setup();
    infoOverride = () => new Response("not found", { status: 404 });

    expect(await getUpstreamSession().ensureCookie()).toBe(COOKIE_HEADER);
  });
});
