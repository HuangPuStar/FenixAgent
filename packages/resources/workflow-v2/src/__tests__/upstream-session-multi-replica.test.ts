// 上游会话的多副本共享（4B）行为契约测试：共享存储读写、跨副本登录租约、降级与失效水位。
//
// 上游一律用 `Bun.serve` 起的本地假实例（与 `upstream-session.test.ts` 同一口径）；Redis 用结构化替身经
// `initializeTestApplicationInfrastructure({ redisConnection })` 注入——走的是生产读取路径
// （`getRedisConnection()`），不是给模块留的测试分支。
//
// 「另一个副本」用 `resetUpstreamSessionLocalStateForTests()` 模拟：它清空本进程的会话记忆但保留共享存储，
// 正是另一个副本眼中的世界。等待窗口与轮询间隔经 `setUpstreamSessionTimingForTests` 压到毫秒级，
// 用例不需要真等 8 秒。
//
// 凭据纪律：会话值由运行期生成，源码里不写凭据字面量；断言只比对「出站 Cookie 与存储里的值一致」。

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { resetPlatformAccountLocaleForTests } from "../server/services/platform-account-locale";
import {
  getUpstreamSession,
  resetUpstreamSessionForTests,
  resetUpstreamSessionLocalStateForTests,
  setUpstreamSessionTimingForTests,
  UpstreamSessionUnavailableError,
} from "../server/services/upstream-session";
import { getUpstreamSessionStore, UPSTREAM_SESSION_REDIS_KEYS } from "../server/services/upstream-session-store";
import { createWorkflowV2ModuleConfig } from "../server/testing";

/** fixture 账号：保留域邮箱 + 运行期生成的密码（不写任何看起来像真凭据的字面量）。 */
const TEST_EMAIL = "workflow-v2-multi-replica@example.invalid";
const TEST_PASSWORD = `fixture-${crypto.randomUUID()}`;
/** 会话值由运行期生成：既避免源码里的凭据字面量，又足以断言出站注入与共享存储内容。 */
const COOKIE_VALUE = `session-key-fixture-${crypto.randomUUID()}`;
const LEASE_TOKEN = "lease-fixture-other-replica";

interface FakeRequest {
  path: string;
  cookie: string | null;
}

let upstreamServer: ReturnType<typeof Bun.serve> | null = null;
const upstreamRequests: FakeRequest[] = [];
let upstreamHandler: (request: FakeRequest) => Response | Promise<Response> = () =>
  new Response("用例未设置假上游处理器", { status: 500 });

function upstreamBaseUrl(): string {
  if (upstreamServer === null) throw new Error("假上游尚未启动");
  return `http://127.0.0.1:${upstreamServer.port}`;
}

function loginOk(cookieValue: string = COOKIE_VALUE): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data: { user_id_str: "upstream-user-fixture" } }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      // domain 带端口是上游实测形态（非法 domain，正是手工解析 Set-Cookie 的理由）。
      "set-cookie": `session_key=${cookieValue}; max-age=2592000; domain=127.0.0.1:18080; path=/`,
    },
  });
}

/** 探活的成功响应：信封 `code: 0`。 */
function probeOk(): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** 平台账号 locale 校正的读取端点；搭在 `ensureCookie` 上，但由本文件之外的用例文件覆盖（见 fetch 里的拦截）。 */
const LOCALE_PROBE_PATH = "/api/passport/account/info/v2/";

beforeAll(() => {
  upstreamServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      // 平台账号 locale 校正搭在 `ensureCookie` 上（见 `platform-account-locale`），但那是另一个关注点、有自己的
      // 用例文件：这里就地应答「已是 zh-CN」（只读、无写）且不记进请求记录，本文件的计数因此只反映会话链路。
      if (url.pathname === LOCALE_PROBE_PATH) {
        return new Response(JSON.stringify({ code: 0, data: { locale: "zh-CN" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const recorded: FakeRequest = {
        path: url.pathname,
        cookie: request.headers.get("cookie"),
      };
      // 登录腿的请求体含账号密码，一律不记录（只留路径）。
      upstreamRequests.push(recorded);
      return upstreamHandler(recorded);
    },
  });
});

afterAll(() => {
  upstreamServer?.stop(true);
  upstreamServer = null;
});

/**
 * Redis 替身：只实现会话存储用到的那几条命令。
 *
 * `failMode` 用来驱动降级路径（命令抛错）；`store` 直接暴露给用例读写（模拟另一个副本的写入）。
 */
function fakeRedis() {
  const store = new Map<string, { value: string; expiresAtMs: number | null }>();
  const state = {
    store,
    failMode: null as null | "all",
    setCalls: [] as { key: string; px: number; nx: boolean }[],
  };
  /** 过期即不可见：与 Redis 的 PX 语义一致（用例靠它断言会话/租约的存活期）。 */
  const alive = (key: string) => {
    const entry = store.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry;
  };
  const assertUsable = () => {
    if (state.failMode === "all") throw new Error("fixture redis unavailable");
  };

  return {
    state,
    client: {
      async get(key: string) {
        assertUsable();
        return alive(key)?.value ?? null;
      },
      async set(key: string, value: string, _px: "PX", milliseconds: number, nx?: "NX") {
        assertUsable();
        state.setCalls.push({ key, px: milliseconds, nx: nx === "NX" });
        if (nx === "NX" && alive(key) !== null) return null;
        store.set(key, { value, expiresAtMs: Date.now() + milliseconds });
        return "OK";
      },
      async del(key: string) {
        assertUsable();
        store.delete(key);
        return 1;
      },
      async eval(_script: string, _numKeys: number, key: string, token: string) {
        assertUsable();
        // 与生产脚本同语义：值仍是自己的 token 才删。
        const entry = alive(key);
        if (entry === null || entry.value !== token) return 0;
        store.delete(key);
        return 1;
      },
    },
  };
}

type FakeRedis = ReturnType<typeof fakeRedis>;

/** 装配：复位替身 → 注入模块配置与 Redis 替身 → 清空会话的进程内状态与存储替身。 */
function setup(options: { redis?: FakeRedis | null } = {}): { redis: FakeRedis | null; requests: FakeRequest[] } {
  const redis = options.redis ?? null;
  resetAllStubs();
  upstreamRequests.length = 0;
  upstreamHandler = () => loginOk();
  initializeTestApplicationInfrastructure({
    moduleConfigs: {
      "workflow-v2": createWorkflowV2ModuleConfig({
        upstreamBaseUrl: upstreamBaseUrl(),
        accountEmail: TEST_EMAIL,
        accountPassword: TEST_PASSWORD,
      }),
    },
    // 未传替身时显式声明「本进程没有 Redis」，与宿主未配置 `RCS_REDIS_URL` 同形。
    redisConnection: redis === null ? null : () => redis.client,
  });
  resetUpstreamSessionForTests();
  // locale 校正是进程级记忆（成功即记住）：不复位就会让本文件第一个用例与后续用例的出站次数不同。
  resetPlatformAccountLocaleForTests();
  // 等待窗口压到毫秒级：时间敏感行为必须能在包级测试里被驱动，而不是真等 8 秒。
  setUpstreamSessionTimingForTests({ loginWaitMs: 300, loginWaitPollIntervalMs: 20 });
  return { redis, requests: upstreamRequests };
}

/** 登录请求的次数（排除探活）。 */
const loginAttempts = (requests: readonly FakeRequest[]): number =>
  requests.filter((request) => request.path.startsWith("/api/passport/")).length;

/** 读共享存储里的会话记录；不存在返回 null。 */
function storedSession(redis: FakeRedis): { cookieHeader: string; loggedInAt: number } | null {
  const raw = redis.state.store.get(UPSTREAM_SESSION_REDIS_KEYS.session)?.value;
  if (raw === undefined) return null;
  return JSON.parse(raw) as { cookieHeader: string; loggedInAt: number };
}

afterEach(() => {
  resetAllStubs();
  resetUpstreamSessionForTests();
});

describe("上游会话的多副本共享", () => {
  // 登录必须把会话写进共享存储（带 PX 过期），否则别的副本仍然只能各自登录并互相踢键。
  test("登录后把会话写进共享存储并带过期时间", async () => {
    const { redis, requests } = setup({ redis: fakeRedis() });
    if (redis === null) throw new Error("用例必须注入 Redis 替身");

    const cookie = await getUpstreamSession().ensureCookie();

    expect(cookie).toBe(`session_key=${COOKIE_VALUE}`);
    expect(loginAttempts(requests)).toBe(1);
    expect(storedSession(redis)).toMatchObject({ cookieHeader: cookie });
    const written = redis.state.setCalls.find((call) => call.key === UPSTREAM_SESSION_REDIS_KEYS.session);
    // 会话按上游声明的 max-age（30 天）存活，而不是永久驻留。
    expect(written?.px).toBeGreaterThan(24 * 60 * 60 * 1000);
    expect(getUpstreamSessionStore().currentBackend()).toBe("redis");
  });

  // 另一个副本（进程内没有会话记忆）直接复用共享存储里的会话：这是多副本不互相踢键的核心判据。
  test("另一个副本复用共享会话，不重新登录", async () => {
    const { redis, requests } = setup({ redis: fakeRedis() });

    const first = await getUpstreamSession().ensureCookie();
    resetUpstreamSessionLocalStateForTests();

    const second = await getUpstreamSession().ensureCookie();

    expect(second).toBe(first);
    expect(loginAttempts(requests)).toBe(1);
    expect(redis).not.toBeNull();
  });

  // 进程刚重启时探活也要能看到共享存储里的会话（否则控制台会把新副本显示成 degraded）。
  test("进程无本地记忆时探活复用共享会话", async () => {
    const { redis, requests } = setup({ redis: fakeRedis() });
    if (redis === null) throw new Error("用例必须注入 Redis 替身");
    await getUpstreamSession().ensureCookie();
    resetUpstreamSessionLocalStateForTests();
    upstreamHandler = () => probeOk();

    expect(await getUpstreamSession().probe()).toBe(true);
    // 探活只打一次 space/list，不触发登录。
    expect(requests.map((request) => request.path)).toEqual([
      "/api/passport/web/email/login/",
      "/api/playground_api/space/list",
    ]);
    expect(requests[1]?.cookie).toBe(`session_key=${COOKIE_VALUE}`);
  });

  // 租约被别的副本持有时本副本**不登录**，而是轮询等它发布会话：上游是单会话账号，并发登录会互相踢键。
  test("租约被占时等待对方发布会话而不是并发登录", async () => {
    const { redis, requests } = setup({ redis: fakeRedis() });
    if (redis === null) throw new Error("用例必须注入 Redis 替身");
    redis.state.store.set(UPSTREAM_SESSION_REDIS_KEYS.loginLease, {
      value: LEASE_TOKEN,
      expiresAtMs: Date.now() + 5_000,
    });
    // 另一个副本在等待窗口内完成登录并把会话写进共享存储。
    setTimeout(() => {
      redis.state.store.set(UPSTREAM_SESSION_REDIS_KEYS.session, {
        value: JSON.stringify({
          cookieHeader: `session_key=${COOKIE_VALUE}`,
          expiresAtMs: null,
          loggedInAt: Date.now() + 1,
          platformUserId: null,
        }),
        expiresAtMs: Date.now() + 60_000,
      });
    }, 60);

    const cookie = await getUpstreamSession().ensureCookie();

    expect(cookie).toBe(`session_key=${COOKIE_VALUE}`);
    expect(loginAttempts(requests)).toBe(0);
  });

  // 租约持有者失败/崩溃：等待窗口过后本副本抢一次租约自己登录（有界重试，不无限等下去）。
  test("对方租约过期后本副本接手登录", async () => {
    const { redis, requests } = setup({ redis: fakeRedis() });
    if (redis === null) throw new Error("用例必须注入 Redis 替身");
    // 租约只剩 50ms：等待窗口（300ms）内必然过期，本副本应接手。
    redis.state.store.set(UPSTREAM_SESSION_REDIS_KEYS.loginLease, {
      value: LEASE_TOKEN,
      expiresAtMs: Date.now() + 50,
    });

    const cookie = await getUpstreamSession().ensureCookie();

    expect(cookie).toBe(`session_key=${COOKIE_VALUE}`);
    expect(loginAttempts(requests)).toBe(1);
  });

  // 租约被占且始终没有会话：如实以 `busy` 失败，也不并发登录（宁可这一次请求失败，也不踢掉对方的键）。
  test("租约被占且等待窗口内无会话时抛 busy 且不登录", async () => {
    const { redis, requests } = setup({ redis: fakeRedis() });
    if (redis === null) throw new Error("用例必须注入 Redis 替身");
    // 租约远长于等待窗口：本副本两次抢租约都会失败。
    redis.state.store.set(UPSTREAM_SESSION_REDIS_KEYS.loginLease, {
      value: LEASE_TOKEN,
      expiresAtMs: Date.now() + 60_000,
    });

    const error = await getUpstreamSession()
      .ensureCookie()
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UpstreamSessionUnavailableError);
    expect((error as UpstreamSessionUnavailableError).reason).toBe("busy");
    expect(loginAttempts(requests)).toBe(0);
  });

  // 主动失效必须清掉共享存储：否则别的副本会把一个已被上游踢掉的键再捡回来用。
  test("invalidate 清掉共享存储里的会话", async () => {
    const { redis } = setup({ redis: fakeRedis() });
    if (redis === null) throw new Error("用例必须注入 Redis 替身");
    await getUpstreamSession().ensureCookie();
    expect(storedSession(redis)).not.toBeNull();

    getUpstreamSession().invalidate();
    // 删除是异步尽力而为：等它落地再断言（失败会记日志，不会让断言变成假绿）。
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(storedSession(redis)).toBeNull();
  });

  // 删不掉（Redis 只允许读）时也不能复活旧会话：失效水位必须让下一次调用去登录，而不是再拿旧键去打上游。
  test("共享存储删除失败时不再采纳旧会话", async () => {
    const { redis, requests } = setup({ redis: fakeRedis() });
    if (redis === null) throw new Error("用例必须注入 Redis 替身");
    await getUpstreamSession().ensureCookie();
    const firstLoggedInAt = storedSession(redis)?.loggedInAt ?? 0;
    // 只让删除失败：读仍可用，模拟「键还在 Redis 里」的残留。
    redis.client.del = async () => {
      throw new Error("fixture redis read-only");
    };

    getUpstreamSession().invalidate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await getUpstreamSession().ensureCookie();

    // 判据是「又登录了一次」而不是「会话值不同」：上游在同一秒内可能发回同一个键，值相等不代表复用了旧会话。
    expect(loginAttempts(requests)).toBe(2);
    expect(storedSession(redis)?.cookieHeader).toBe(second);
    expect(storedSession(redis)?.loggedInAt ?? 0).toBeGreaterThanOrEqual(firstLoggedInAt);
  });

  // Redis 未配置（宿主未设 `RCS_REDIS_URL`）时降级为进程内单例：登录照常可用，且显式反映在 backend 上。
  test("没有 Redis 时降级为进程内单例并照常登录", async () => {
    const { requests } = setup({ redis: null });

    const first = await getUpstreamSession().ensureCookie();
    const second = await getUpstreamSession().ensureCookie();

    expect(first).toBe(second);
    expect(loginAttempts(requests)).toBe(1);
    expect(getUpstreamSessionStore().currentBackend()).toBe("memory");
  });

  // Redis 操作出错时同样降级（不是让请求失败）：降级只影响「谁能复用登录态」，不影响访问判定。
  test("Redis 命令失败时降级到进程内并继续服务", async () => {
    const { redis, requests } = setup({ redis: fakeRedis() });
    if (redis === null) throw new Error("用例必须注入 Redis 替身");
    redis.state.failMode = "all";

    const cookie = await getUpstreamSession().ensureCookie();

    expect(cookie).toBe(`session_key=${COOKIE_VALUE}`);
    expect(loginAttempts(requests)).toBe(1);
    expect(getUpstreamSessionStore().currentBackend()).toBe("memory");
    // 降级期间不写入共享存储：一致的后端比「半写」更可预期。
    expect(storedSession(redis)).toBeNull();
  });

  // 并发 ensureCookie 在 Redis 模式下同样只登录一次（进程内单飞 + 跨副本租约两层都要有）。
  test("并发 ensureCookie 只登录一次并只取一次租约", async () => {
    const { redis, requests } = setup({ redis: fakeRedis() });
    if (redis === null) throw new Error("用例必须注入 Redis 替身");

    const cookies = await Promise.all([
      getUpstreamSession().ensureCookie(),
      getUpstreamSession().ensureCookie(),
      getUpstreamSession().ensureCookie(),
    ]);

    expect(new Set(cookies).size).toBe(1);
    expect(loginAttempts(requests)).toBe(1);
    expect(redis.state.setCalls.filter((call) => call.key === UPSTREAM_SESSION_REDIS_KEYS.loginLease)).toHaveLength(1);
    expect(redis.state.setCalls.find((call) => call.key === UPSTREAM_SESSION_REDIS_KEYS.loginLease)?.nx).toBe(true);
  });
});
