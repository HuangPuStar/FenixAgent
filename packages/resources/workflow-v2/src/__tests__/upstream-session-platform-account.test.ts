import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { Elysia } from "elysia";
import { createWebWorkflowV2PlatformAccountRoutes } from "../server/routes/web/platform-account";
import { getUpstreamSession } from "../server/services/upstream-session";
import { createWorkflowV2ModuleConfig } from "../server/testing";

/**
 * `/web/workflow-v2/platform-account`（1B 填充的 handler）的协议行为测试。
 *
 * 鉴权守卫用替身：`sessionAuth` 的口径由宿主保证（`apps/server/src/plugins/auth.ts`），本文件只验证
 * 控制面响应形状与「凭据不外泄」——平台账号状态会被浏览器与控制台日志消费，出现会话值即是事故。
 *
 * 本文件所有凭据都是明显假的 fixture（保留域邮箱 + 标记串），不使用也不记录真实凭据。
 */

const TEST_EMAIL = "workflow-v2-route@example.invalid";
const TEST_PASSWORD = "fixture-password-2b6e-not-a-secret";
const COOKIE_VALUE = "session-key-route-fixture-77c1";
const LOGIN_PATH = "/api/passport/web/email/login/";
/** 按需引导会走到的另两条上游路径（注册与空间列表）。 */
const REGISTER_PATH = "/api/passport/web/email/register/v2/";
const SPACE_LIST_PATH = "/api/playground_api/space/list";
/** 台账 fixture 里的空间 ID：断言到具体值，避免只验「非空」而漏掉投影取错列。 */
const SPACE_ID = "upstream-space-route-fixture-2f19";
/** 读失败替身抛出的标记串：用来确认内部故障细节没有随 500 响应外泄。 */
const DB_FAILURE_MESSAGE = "db fixture failure: connection pool exhausted";

/** 守卫替身：声明路由用到的 `sessionAuth` 宏并放行（不校验身份，身份语义不属本文件验证范围）。 */
const guardStub = new Elysia({ name: "platform-account-test-guard" }).macro({
  sessionAuth: (_enabled: boolean) => ({}),
});

/**
 * 假上游：**整个文件共用一个**实例（`beforeAll` 起、`afterAll` 停），用例只替换响应处理器。
 *
 * 为什么不是「每个用例起停一个服务器」：`Bun.serve({ port: 0 })` 反复释放/重绑端口时，进程内 fetch 的连接池
 * 可能仍持有指向刚被停掉的服务端的 keep-alive 连接——复用该连接会得到网络错误；端口若在窗口期被机器上其它
 * 进程占用，还会收到对方的 401/404。这类失败与被测行为无关，实测在 20~200 次运行中偶发 1 次。
 * 单实例把端口 churn 降到每文件一次；用例之间只重置请求记录与处理器。
 */
let upstreamServer: ReturnType<typeof Bun.serve> | null = null;

/** 假上游收到的请求路径（当前用例的）；`setup()` 就地清空，保持引用稳定。 */
const upstreamRequests: string[] = [];

/** 当前用例的响应处理器；未设置就发请求时立刻以 500 暴露，而不是静默返回空响应。 */
let upstreamHandler: (path: string) => Response = () => new Response("用例未设置假上游处理器", { status: 500 });

/** 共用的假上游基址；未启动即使用说明用例顺序错了。 */
function upstreamBaseUrl(): string {
  if (upstreamServer === null) throw new Error("假上游尚未启动");
  return `http://127.0.0.1:${upstreamServer.port}`;
}

beforeAll(() => {
  upstreamServer = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      upstreamRequests.push(url.pathname);
      return upstreamHandler(url.pathname);
    },
  });
});

afterAll(() => {
  upstreamServer?.stop(true);
  upstreamServer = null;
});

/** 正常登录响应；`Set-Cookie` 的 domain 带端口（上游实测形态）。 */
function loginOk(): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data: { user_id_str: "upstream-user-fixture" } }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `session_key=${COOKIE_VALUE}; max-age=2592000; domain=127.0.0.1:18080; path=/; HttpOnly; SameSite`,
    },
  });
}

/** 上游信封响应。 */
function envelope(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

/**
 * 平台账号台账行的最小 fixture：被测 handler 只读 `platformSpaceId`，其余列按台账行形状给值，让替身与真实行
 * 不至于漂移；时间列用固定值，避免断言依赖运行时刻。
 */
function platformAccountRow(platformSpaceId: string) {
  return {
    platformUserId: "upstream-user-fixture",
    platformSpaceId,
    email: TEST_EMAIL,
    status: "active",
    lastLoginAt: new Date("2026-01-01T00:00:00.000Z"),
    lastProbeAt: null,
    lastError: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

type PlatformAccountRow = ReturnType<typeof platformAccountRow>;

/** 台账查询链的最小形状：`findPlatformAccount()` 只走到 `select().from().orderBy().limit()`。 */
interface PlatformAccountQueryChain {
  from: () => PlatformAccountQueryChain;
  orderBy: () => PlatformAccountQueryChain;
  limit: () => Promise<readonly PlatformAccountRow[]>;
}

/** 台账读替身：`select` 返回链式替身，`await` 后得到给定行集（空数组即「台账无行」）。 */
function stubDbWithRows(rows: readonly PlatformAccountRow[]) {
  const chain: PlatformAccountQueryChain = {
    from: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return { select: () => chain };
}

/** 台账读失败替身：句柄取用即抛（模拟连接池不可用一类的基础设施故障）。 */
function stubDbWithFailure() {
  return {
    select: () => {
      throw new Error(DB_FAILURE_MESSAGE);
    },
  };
}

/** 个人空间列表响应（`space_type === 1` 是个人空间，见 `pickPersonalSpaceId`）。 */
function spaceListOk(): Response {
  return envelope({
    code: 0,
    data: {
      bot_space_list: [
        { id: `${SPACE_ID}-team`, space_type: 2 },
        { id: SPACE_ID, space_type: 1 },
      ],
    },
  });
}

/** 注册响应：账号已存在（引导据此幂等跳过建号，随后照常登录）。 */
function registerAlreadyExists(): Response {
  return envelope({ code: 700000001, msg: "email already exist" });
}

/**
 * 冷启动的可写台账替身：读返回 `rows`，写把行推进同一个数组（并发路径的 upsert 按 `platformUserId` 收敛）。
 *
 * 与 `stubDbWithRows` 分开：那个只服务「读路径」用例，写链（`insert().values().onConflictDoUpdate()` /
 * `update().set().where()`）是**按需引导**新增的必经之路，缺了它只能测到 persist_failed 分支。
 */
function stubWritableDb(rows: PlatformAccountRow[] = []) {
  const upsert = (values: Record<string, unknown>) => {
    const next = { ...platformAccountRow(String(values.platformSpaceId ?? "")), ...values } as PlatformAccountRow;
    const index = rows.findIndex((row) => row.platformUserId === next.platformUserId);
    if (index >= 0) rows[index] = next;
    else rows.push(next);
    return Promise.resolve([next]);
  };
  const chain: PlatformAccountQueryChain = {
    from: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return {
    select: () => chain,
    insert: () => ({
      values: (values: Record<string, unknown>) => ({ onConflictDoUpdate: () => upsert(values) }),
    }),
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: () => upsert(values) }) }),
  };
}

describe("web platform-account routes", () => {
  let routes: ReturnType<typeof createWebWorkflowV2PlatformAccountRoutes> | null = null;

  /**
   * 换上本用例的处理器与 DB 替身、清空请求记录，并把模块配置指向共用的假上游；每个用例都从「无会话」开始。
   *
   * 不再经 `initializeWorkflowV2ModuleConfig()`：它会先 `resetAllStubs()` 再让 DB 缺省取 `getDbStub()`，
   * 而应用基础设施持有的句柄在初始化时定格——先 `stubDb()` 会被那次复位清掉，「先登记替身再初始化」拿不到
   * 替身。这里改为复用同一份配置 fixture（`createWorkflowV2ModuleConfig`）+ 显式 `database` 注入，口径同
   * `helpers/console-plane-harness.ts` 的 `installDatabase()`；缺省替身是「台账无行」。
   *
   * 返回 `{ requests }` 的是同一个数组引用（`setup()` 就地清空），用例可安全地持有它做断言。
   */
  function setup(handler: (path: string) => Response, database: unknown = stubDbWithRows([])): { requests: string[] } {
    upstreamHandler = handler;
    upstreamRequests.length = 0;
    resetAllStubs();
    initializeTestApplicationInfrastructure({
      database,
      moduleConfigs: {
        "workflow-v2": createWorkflowV2ModuleConfig({
          upstreamBaseUrl: upstreamBaseUrl(),
          accountEmail: TEST_EMAIL,
          accountPassword: TEST_PASSWORD,
        }),
      },
    });
    getUpstreamSession().invalidate();
    routes = createWebWorkflowV2PlatformAccountRoutes({ authGuardPlugin: guardStub });
    return { requests: upstreamRequests };
  }

  afterEach(() => {
    resetAllStubs();
    routes = null;
    upstreamHandler = () => new Response("用例未设置假上游处理器", { status: 500 });
  });

  // 台账**已有行**时读接口零出站：未登录只如实报告 degraded，不因为读请求而去探活或重新登录
  // （无行时的那一次按需引导见下一个用例——它是唯一允许出站的读路径分支）。
  test("GET /platform-account 台账有行且未登录时返回 degraded 且不请求上游", async () => {
    const started = setup(() => loginOk(), stubDbWithRows([platformAccountRow(SPACE_ID)]));

    const response = await routes!.handle(new Request("http://localhost/platform-account"));
    const json = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    // 只断言与会话存在性直接相关的字段：探活时间/结果是进程级历史记忆，同一进程内的其它用例可能已写过，
    // 断言它们为 null 会把「用例间共享单例」误报成产品缺陷。
    expect(json.data).toMatchObject({
      status: "degraded",
      platformUserId: null,
      spaceId: SPACE_ID,
      expiresAt: null,
      lastLoginAt: null,
    });
    expect(started.requests).toHaveLength(0);
  });

  // 台账有行且空间非空时，状态接口必须回该空间：画布页据此判定 upstream 可加载，回 null 会停在 space-missing。
  test("GET /platform-account 回显台账里的 spaceId", async () => {
    const started = setup(() => loginOk(), stubDbWithRows([platformAccountRow(SPACE_ID)]));

    const response = await routes!.handle(new Request("http://localhost/platform-account"));
    const json = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(json.data).toMatchObject({ spaceId: SPACE_ID });
    expect(started.requests).toHaveLength(0);
  });

  // 台账无行时**按需引导**：行丢失（库被清理 / 重建 / 脏测试）会让所有已绑定租户永久停在 space-missing，
  // 而「重试」只是把同一个 null 再读一遍。这里断言首次 GET 就完成「登录 → 取个人空间 → 落台账」并回 spaceId。
  test("GET /platform-account 台账无行时按需引导并回填 spaceId", async () => {
    const rows: PlatformAccountRow[] = [];
    const started = setup(
      (path) =>
        path === REGISTER_PATH ? registerAlreadyExists() : path === SPACE_LIST_PATH ? spaceListOk() : loginOk(),
      stubWritableDb(rows),
    );

    const response = await routes!.handle(new Request("http://localhost/platform-account"));
    const json = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toMatchObject({ spaceId: SPACE_ID });
    // 台账被写回：下一次请求（含重启后的冷启动）不必再引导。
    expect(rows).toHaveLength(1);
    expect(rows[0]?.platformSpaceId).toBe(SPACE_ID);
    expect(started.requests).toContain(LOGIN_PATH);
    expect(started.requests).toContain(SPACE_LIST_PATH);
  });

  // 并发读同一份空台账只引导一次：上游是单会话，重复登录会互相踢键；单飞是这条路径的边界条件。
  test("并发 GET 共享同一次按需引导", async () => {
    const rows: PlatformAccountRow[] = [];
    const started = setup(
      (path) =>
        path === REGISTER_PATH ? registerAlreadyExists() : path === SPACE_LIST_PATH ? spaceListOk() : loginOk(),
      stubWritableDb(rows),
    );

    const responses = await Promise.all([
      routes!.handle(new Request("http://localhost/platform-account")),
      routes!.handle(new Request("http://localhost/platform-account")),
    ]);
    const payloads = (await Promise.all(responses.map((response) => response.json()))) as {
      data?: { spaceId?: string | null };
    }[];

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(payloads.map((payload) => payload.data?.spaceId)).toEqual([SPACE_ID, SPACE_ID]);
    expect(started.requests.filter((path) => path === LOGIN_PATH)).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  // 引导失败是**有界降级**：读接口仍回 200（spaceId null，画布页展示「正在初始化」并自动重试），
  // 不把上游故障升级成 500；台账保持为空，供下一次请求重试引导。
  test("按需引导失败时有界降级：回 200 + spaceId null，不写台账", async () => {
    const rows: PlatformAccountRow[] = [];
    const started = setup(() => new Response("upstream down", { status: 500 }), stubWritableDb(rows));

    const response = await routes!.handle(new Request("http://localhost/platform-account"));
    const json = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toMatchObject({ spaceId: null });
    expect(rows).toHaveLength(0);
    expect(started.requests.length).toBeGreaterThan(0);
  });

  // 读库失败必须显式 500：降级成 200 + spaceId null 会让「DB 挂了」与「尚未引导账号」在画布页上表现成同一个
  // space-missing 死局；对外只给稳定错误码，内部故障细节不得随响应外泄。
  test("GET /platform-account 台账读取失败时返回 500 且不回显内部细节", async () => {
    setup(() => loginOk(), stubDbWithFailure());

    const response = await routes!.handle(new Request("http://localhost/platform-account"));
    const raw = await response.text();
    const json = JSON.parse(raw) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(json).toMatchObject({ success: false, error: { code: "INTERNAL_ERROR" } });
    // 失败不得以成功信封的形态出现（200 + data.spaceId null 是被禁止的降级形态）。
    expect(json).not.toHaveProperty("data");
    expect(raw).not.toContain(DB_FAILURE_MESSAGE);
  });

  // 重登接口是确定行为：调用后进程持有会话，状态接口随之报告 active 与上次登录时间。
  test("POST /platform-account/login 触发登录，随后状态接口报告 active", async () => {
    const started = setup(() => loginOk());

    const loginResponse = await routes!.handle(
      new Request("http://localhost/platform-account/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "manual-relogin" }),
      }),
    );
    const loginJson = (await loginResponse.json()) as Record<string, unknown>;

    expect(loginResponse.status).toBe(200);
    expect(loginJson).toMatchObject({ success: true, data: { status: "active" } });
    expect(started.requests).toEqual([LOGIN_PATH]);

    const statusResponse = await routes!.handle(new Request("http://localhost/platform-account"));
    const statusJson = (await statusResponse.json()) as Record<string, unknown>;
    const data = statusJson.data as Record<string, unknown>;

    expect(data.status).toBe("active");
    expect(data.platformUserId).toBe("upstream-user-fixture");
    expect(typeof data.lastLoginAt).toBe("string");
  });

  // 运维手动触发（curl 不带请求体）也必须可用：`reason` 是可选字段，缺省不得被校验拒绝。
  test("POST /platform-account/login 不带请求体时同样可用", async () => {
    setup(() => loginOk());

    const response = await routes!.handle(new Request("http://localhost/platform-account/login", { method: "POST" }));

    expect(response.status).toBe(200);
  });

  // 「请求体可选」不等于「不校验」：形状不合法应当在协议层被拒，而不是带着脏数据进入会话逻辑。
  test("POST /platform-account/login 请求体形状不合法时被拒", async () => {
    setup(() => loginOk());

    const response = await routes!.handle(
      new Request("http://localhost/platform-account/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: 12345 }),
      }),
    );

    expect(response.status).toBe(422);
  });

  // 凭据边界：状态响应会被浏览器与控制台日志消费，会话值、邮箱、密码一个都不能出现。
  test("状态响应不含会话值、邮箱与密码", async () => {
    setup(() => loginOk());
    await getUpstreamSession().ensureCookie();

    const response = await routes!.handle(new Request("http://localhost/platform-account"));
    const raw = await response.text();

    expect(raw).not.toContain(COOKIE_VALUE);
    expect(raw).not.toContain(TEST_EMAIL);
    expect(raw).not.toContain(TEST_PASSWORD);
  });

  // 重登失败要落到稳定的错误信封与 503，且失败原因只给标签、不回显上游正文或凭据。
  test("POST /platform-account/login 登录被拒时返回 503 且不含凭据", async () => {
    setup(() => envelope({ code: 700000003, msg: `authentication failed for ${TEST_EMAIL}` }));

    const response = await routes!.handle(
      new Request("http://localhost/platform-account/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(raw).toContain("PLATFORM_SESSION_UNAVAILABLE");
    expect(raw).toContain("rejected");
    expect(raw).not.toContain(TEST_EMAIL);
    expect(raw).not.toContain(TEST_PASSWORD);
    expect(raw).not.toContain(COOKIE_VALUE);
  });
});
