// 平台账号自助注册（引导流程的「确保账号存在」步骤）的行为测试。
//
// 上游一律用 `Bun.serve` 起的本地假实例，并按「账号是否存在」建模：注册建号之后登录才成功——这样用例验证的是
// 「注册 → 登录 → 落台账」的真实顺序，而不是把两条链路各自替身化。台账用注入的替身句柄（按 `platform_user_id` 唯一
// 索引模拟冲突语义，写两次就会真的落两行），因此本文件不依赖本地 Postgres；真库上的顺序引导（重复引导不产生第二
// 行）由 `org-app-binding.test.ts` 覆盖，真库上的并发写收敛不在本文件验证范围。
//
// 凭据纪律：凭据一律是明显假的 fixture（保留域邮箱 + 标记串）；注册响应刻意下发与登录不同的会话值，用来证明引导
// 采纳的是登录那一份，而不是注册顺带下发的那一份。

import { afterEach, describe, expect, test } from "bun:test";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { bootstrapPlatformAccount, PlatformAccountBootstrapError } from "../server/services/platform-account-bootstrap";
import { resetPlatformAccountLocaleForTests } from "../server/services/platform-account-locale";
import { resetUpstreamHealth } from "../server/services/upstream-health";
import {
  resetUpstreamSessionForTests,
  setUpstreamSessionTimingForTests,
  UpstreamSessionUnavailableError,
} from "../server/services/upstream-session";
import { createWorkflowV2ModuleConfig } from "../server/testing";

const TEST_EMAIL = "workflow-v2-register@example.invalid";
const TEST_PASSWORD = "fixture-password-7d2a-not-a-secret";
const UPSTREAM_USER_ID = "upstream-user-register-fixture";
const SPACE_ID = "upstream-space-register-fixture";

/** 上游端点（与上游源码的注册路径逐字一致；注册与登录是 `SessionAuthMW` 白名单里仅有的两条免 cookie 路径）。 */
const REGISTER_PATH = "/api/passport/web/email/register/v2/";
const LOGIN_PATH = "/api/passport/web/email/login/";
const SPACE_LIST_PATH = "/api/playground_api/space/list";
/**
 * 平台账号 locale 校正的读取端点；它搭在会话获取上（`upstream-session.ensureCookie`），因此每次引导都会出现
 * ——本文件里显式应答「已是 zh-CN」，让这条校正成为一次只读、无写的稳定出站。
 */
const ACCOUNT_INFO_PATH = "/api/passport/account/info/v2/";

/** 注册/登录各自下发的会话值：两者不同，用来证明后续请求带的是登录那一份。 */
const REGISTER_MINTED_COOKIE = "session-key-register-minted-fixture";
const LOGIN_COOKIE = "session-key-login-fixture";

/** 上游不可达用例的地址：本机 1 号端口没有监听者，连接会被立即拒绝。 */
const UNREACHABLE_BASE_URL = "http://127.0.0.1:1";

/** 邮箱已存在的业务码（上游 `errno.ErrUserEmailAlreadyExistCode`）。 */
const EMAIL_ALREADY_EXISTS_CODE = 700000001;
/** 上游禁止注册的业务码（`errno.ErrNotAllowedRegisterCode`，由 `DISABLE_USER_REGISTRATION` 控制）。 */
const REGISTRATION_DISABLED_CODE = 700000008;

/** 假上游记录的一次请求；请求体（含 fixture 密码）只在本文件内用于断言形状，不进日志与错误文案。 */
interface FakeRequest {
  path: string;
  cookie: string | null;
  /** 注册请求的语言头：上游据此决定新账号的 `locale`（内嵌画布的语言）。 */
  acceptLanguage: string | null;
  body: Record<string, unknown>;
}

/**
 * 假上游与其处理器的**进程级挂载点**。
 *
 * 为什么服务端不住在模块作用域：`--rerun-each N` 会把本文件整份重跑 N 次（模块作用域与 `beforeAll` / `afterAll`
 * 都会重新执行）。每轮重建 `Bun.serve({ port: 0 })` 时，操作系统常把上一轮刚释放的临时端口原样发回来，而进程内
 * fetch 的连接池仍持有指向那个**已停止**服务端的 keep-alive 连接——复用它得到
 * `TypeError: The socket connection was closed unexpectedly`，表现为「整轮用例一起失败」（实测 400 次重跑里偶发
 * 一两轮、每轮 7 个涉及假上游的用例全挂）。服务端只在进程内起一次且不再停止，端口不再 churn，这类与被测行为无关
 * 的失败随之消失；单次运行（`bun test <文件>`）的行为完全不变。
 *
 * 处理器则**每轮重装**：模块作用域会重新求值，新的一轮有自己的请求记录与账号表，长驻的服务端必须转发给最新那份，
 * 否则断言会读到上一轮的陈旧状态。
 */
const anchor = globalThis as typeof globalThis & {
  __wf2RegistrationUpstream?: ReturnType<typeof Bun.serve>;
  __wf2RegistrationUpstreamHandler?: (request: FakeRequest) => Response;
};

/** 取（必要时启动）进程级假上游；端口交给操作系统分配。 */
function upstreamServer(): ReturnType<typeof Bun.serve> {
  anchor.__wf2RegistrationUpstream ??= Bun.serve({
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
      const handler = anchor.__wf2RegistrationUpstreamHandler;
      if (handler === undefined) return new Response("用例未装载假上游处理器", { status: 500 });
      return handler({
        path: url.pathname,
        cookie: request.headers.get("cookie"),
        acceptLanguage: request.headers.get("accept-language"),
        body,
      });
    },
  });
  return anchor.__wf2RegistrationUpstream;
}

const upstreamRequests: FakeRequest[] = [];
/** 假上游里的账号表：注册建号，登录只认已建的邮箱——「账号不存在则登录失败」是本文件的前提。 */
const registeredEmails = new Set<string>();
/** 注册端点的响应覆盖（驱动「上游禁止注册」「未知业务码」等分支）；`null` 表示走假账号表。 */
let registerOverride: ((body: Record<string, unknown>) => Response) | null = null;

function upstreamBaseUrl(): string {
  return `http://127.0.0.1:${upstreamServer().port}`;
}

/** 上游信封响应。 */
function envelope(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/** 登录成功响应；`session_key` 只在 `Set-Cookie`（上游实测形态，响应体不含凭据）。 */
function loginOk(): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data: { user_id_str: UPSTREAM_USER_ID } }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `session_key=${LOGIN_COOKIE}; max-age=2592000; domain=127.0.0.1:18080; path=/; HttpOnly`,
    },
  });
}

/** 真实上游的注册行为：邮箱已存在回 `700000001`，否则建号并顺带下发一个会话（引导必须忽略它）。 */
function registerResponse(body: Record<string, unknown>): Response {
  const email = String(body.email ?? "");
  if (registeredEmails.has(email)) return envelope({ code: EMAIL_ALREADY_EXISTS_CODE, msg: "email already exist" });
  registeredEmails.add(email);
  return new Response(JSON.stringify({ code: 0, msg: "success", data: { user_id_str: UPSTREAM_USER_ID } }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `session_key=${REGISTER_MINTED_COOKIE}; max-age=2592000; domain=127.0.0.1:18080; path=/`,
    },
  });
}

/** 真实上游的登录行为：账号不存在与密码错误共用 `700000003`（`ErrUserInfoInvalidateCode`）。 */
function loginResponse(body: Record<string, unknown>): Response {
  if (!registeredEmails.has(String(body.email ?? ""))) {
    return envelope({ code: 700000003, msg: "invalid email or password, please try again." });
  }
  return loginOk();
}

function handleUpstream(request: FakeRequest): Response {
  upstreamRequests.push(request);
  switch (request.path) {
    case REGISTER_PATH:
      return registerOverride === null ? registerResponse(request.body) : registerOverride(request.body);
    case LOGIN_PATH:
      return loginResponse(request.body);
    case ACCOUNT_INFO_PATH:
      // 账号本来就说中文：校正只读一次即判定无需改写，写请求不会出现（写路径由 `platform-account-locale` 的用例覆盖）。
      return envelope({ code: 0, data: { locale: "zh-CN" } });
    case SPACE_LIST_PATH:
      // 除注册与登录外一律要求会话（无 Cookie 一律 401），因此出站 Cookie 的取值在本用例里可断言。
      return request.cookie === `session_key=${LOGIN_COOKIE}`
        ? envelope({ code: 0, data: { bot_space_list: [{ id: SPACE_ID, space_type: 1 }] } })
        : envelope({ code: 401, msg: "missing session_key in cookie" }, 401);
    default:
      return new Response("not found", { status: 404 });
  }
}

// 每轮重跑都会重新求值模块作用域：把本轮（含本轮的请求记录与账号表）的处理器装到进程级假上游上。
anchor.__wf2RegistrationUpstreamHandler = handleUpstream;

/** 台账行的最小 fixture 形状；写入路径不带 `createdAt`（真实表由默认值补齐），读取路径按完整行返回。 */
interface AccountRow {
  platformUserId: string;
  platformSpaceId: string;
  email: string;
  status: string;
  lastLoginAt: Date;
  lastProbeAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 台账替身：只实现引导用到的三条链（`select … orderBy … limit`、`update … set … where`、
 * `insert … values … onConflictDoUpdate`）。
 *
 * 冲突语义按真表的唯一索引（`platform_user_id`，见 `db/schema.ts`）实现：同 user 合并、**不同 user 落成第二行**。
 * 这正是「台账只有一行」这类断言的意义所在——若实现变成写两次（哪怕每次 user id 相同也会合并，但换了身份就
 * 会真的多出一行），`rows.length` 会立刻变成 2，而不是被替身悄悄吞掉。`insertAttempts` 用来断言「有行时只更新、
 * 不再插入」。
 */
function createLedgerStub() {
  const rows: AccountRow[] = [];
  let insertAttempts = 0;
  const handle = {
    select: () => ({ from: () => ({ orderBy: () => ({ limit: async (): Promise<AccountRow[]> => [...rows] }) }) }),
    update: () => ({
      set: (values: Partial<AccountRow>) => ({
        where: async (): Promise<void> => {
          const [row] = rows;
          if (row) rows[0] = { ...row, ...values };
        },
      }),
    }),
    insert: () => {
      insertAttempts += 1;
      return {
        values: (values: Omit<AccountRow, "createdAt">) => ({
          onConflictDoUpdate: async ({ set }: { set: Partial<AccountRow> }): Promise<void> => {
            const conflictIndex = rows.findIndex((row) => row.platformUserId === values.platformUserId);
            if (conflictIndex >= 0) rows[conflictIndex] = { ...rows[conflictIndex], ...set };
            else rows.push({ ...values, createdAt: new Date() });
          },
        }),
      };
    },
  };
  return { handle, rows, insertAttempts: () => insertAttempts };
}

describe("workflow-v2 平台账号自助注册", () => {
  /**
   * 复位假上游状态、会话记忆与台账替身，并把模块配置指向共用的假上游。
   *
   * 返回的是同一个请求数组与同一个台账数组的引用（就地清空 / 复用），用例可安全持有它们做断言。
   */
  function setup(options: { baseUrl?: string; register?: (body: Record<string, unknown>) => Response } = {}): {
    requests: FakeRequest[];
    ledger: AccountRow[];
    insertAttempts: () => number;
  } {
    upstreamRequests.length = 0;
    registeredEmails.clear();
    registerOverride = options.register ?? null;
    const ledger = createLedgerStub();
    resetAllStubs();
    resetUpstreamSessionForTests();
    // locale 校正是进程级记忆（成功即记住、失败进冷却）：不复位就会把「本文件第一个用例」与后续用例区分开，
    // 而且同进程的其它用例文件也会影响这里的请求条数——用例必须各自从零开始。
    resetPlatformAccountLocaleForTests();
    // 熔断器是进程级单例：同进程的其它用例文件可能把它推到打开态，不复位会让本文件的 callUpstream 直接短路。
    resetUpstreamHealth();
    initializeTestApplicationInfrastructure({
      database: ledger.handle,
      moduleConfigs: {
        "workflow-v2": createWorkflowV2ModuleConfig({
          upstreamBaseUrl: options.baseUrl ?? upstreamBaseUrl(),
          accountEmail: TEST_EMAIL,
          accountPassword: TEST_PASSWORD,
        }),
      },
    });
    return { requests: upstreamRequests, ledger: ledger.rows, insertAttempts: ledger.insertAttempts };
  }

  /** 取引导失败的异常对象；不用 `rejects` 是因为还要断言异常的 `reason` 与 `message`。 */
  async function bootstrapFailure(): Promise<unknown> {
    return await bootstrapPlatformAccount().then(
      () => null,
      (error: unknown) => error,
    );
  }

  afterEach(() => {
    resetAllStubs();
    registerOverride = null;
    registeredEmails.clear();
  });

  // 首启建号：账号不存在时先注册、再登录，最后把身份落进台账——部署方只注入邮箱与密码就能起。
  test("账号不存在时先注册再登录，并把账号身份写进台账", async () => {
    const started = setup();

    const snapshot = await bootstrapPlatformAccount();

    // 顺序即语义：注册必须在登录之前（账号不存在时登录只会拿到 700000003）；账号信息那次只读是会话获取
    // 顺带做的 locale 校正（`ensureCookie`），它排在登录之后、空间列表之前。
    expect(started.requests.map((item) => item.path)).toEqual([
      REGISTER_PATH,
      LOGIN_PATH,
      ACCOUNT_INFO_PATH,
      SPACE_LIST_PATH,
    ]);
    // 注册是免 cookie 白名单路径，且 body 只需 email + password。
    expect(started.requests[0]?.cookie).toBeNull();
    expect(started.requests[0]?.body).toEqual({ email: TEST_EMAIL, password: TEST_PASSWORD });
    // 语言头决定新账号的 `locale`：不带它就等于把账号建成了英文（上游缺失时默认 en-US），画布会整幅英文。
    expect(started.requests[0]?.acceptLanguage).toBe("zh-CN");
    // 注册响应也带 Set-Cookie，但引导采纳的必须是登录下发的那一份（否则同一次引导会出现第二条登录态路径）。
    expect(started.requests[3]?.cookie).toBe(`session_key=${LOGIN_COOKIE}`);
    expect(started.requests[3]?.cookie).not.toContain(REGISTER_MINTED_COOKIE);

    expect(snapshot).toMatchObject({
      platformUserId: UPSTREAM_USER_ID,
      platformSpaceId: SPACE_ID,
      email: TEST_EMAIL,
      status: "active",
      lastError: null,
    });
    expect(started.ledger).toHaveLength(1);
    expect(started.ledger[0]).toMatchObject({
      platformUserId: UPSTREAM_USER_ID,
      platformSpaceId: SPACE_ID,
      email: TEST_EMAIL,
    });
    // 新账号走的是插入（不是更新），且只插一次：这条断言让「台账只有一行」不再是恒真命题。
    expect(started.insertAttempts()).toBe(1);
  });

  // 账号已存在（人工建号的既有部署）：注册返回「邮箱已存在」按成功处理，直接登录继续，重复引导不产生第二行。
  test("邮箱已存在时注册按成功处理，重复引导幂等且台账只有一行", async () => {
    const started = setup();
    registeredEmails.add(TEST_EMAIL);

    const first = await bootstrapPlatformAccount();
    const second = await bootstrapPlatformAccount();

    expect(first.platformUserId).toBe(UPSTREAM_USER_ID);
    expect(second.platformUserId).toBe(UPSTREAM_USER_ID);
    // 两次引导各注册一次，都拿到「已存在」；它不产生副作用，因此重复执行为安全。
    expect(started.requests.filter((item) => item.path === REGISTER_PATH)).toHaveLength(2);
    // 第二次引导命中既有行，只更新不再插入：行数与插入次数都不变。
    expect(started.insertAttempts()).toBe(1);
    expect(started.ledger).toHaveLength(1);
  });

  // 注册被上游禁用且账号登录不上：必须给出「上游禁止注册」这一档原因，而不是含糊的「登录失败」。
  test("上游禁止注册且账号登录失败时，失败原因为 registration_disabled", async () => {
    const started = setup({
      register: () => envelope({ code: REGISTRATION_DISABLED_CODE, msg: "not allowed register" }),
    });

    const failure = await bootstrapFailure();

    expect(failure).toBeInstanceOf(PlatformAccountBootstrapError);
    if (!(failure instanceof PlatformAccountBootstrapError))
      throw new Error("引导应以 PlatformAccountBootstrapError 失败");
    expect(failure.reason).toBe("registration_disabled");
    // 文案要能让运维直接判断动作：是上游关着注册，而不是「登录失败」这类糊在一起的报错。
    expect(failure.message).toContain("700000008");
    expect(failure.message).not.toContain(TEST_PASSWORD);
    expect(failure.message).not.toContain(TEST_EMAIL);
    // 两个会话值（注册顺带下发的、登录下发的）都不得出现在错误链里：错误可能被日志与响应消费。
    const serialized = `${failure.message} ${String(failure.cause)}`;
    expect(serialized).not.toContain(REGISTER_MINTED_COOKIE);
    expect(serialized).not.toContain(LOGIN_COOKIE);
    // 仍然走完了登录（注册不单独决定成败）：请求只有注册 + 登录两条——会话没拿到，locale 校正那一步也就不会
    // 发生（它排在会话获取成功之后），失败在半成品落库之前。
    expect(started.requests.map((item) => item.path)).toEqual([REGISTER_PATH, LOGIN_PATH]);
    expect(started.ledger).toHaveLength(0);
  });

  // 注册返回未知业务码：失败原因带上该码，可与「注册被禁」「登录失败」区分开，便于对着上游日志排查。
  test("注册返回未知业务码时，失败原因可诊断并带上该码", async () => {
    setup({ register: () => envelope({ code: 700000009, msg: "unexpected register failure" }) });

    const failure = await bootstrapFailure();

    expect(failure).toBeInstanceOf(PlatformAccountBootstrapError);
    if (!(failure instanceof PlatformAccountBootstrapError))
      throw new Error("引导应以 PlatformAccountBootstrapError 失败");
    expect(failure.reason).toBe("registration_failed");
    expect(failure.message).toContain("code=700000009");
    expect(failure.message).not.toContain(TEST_PASSWORD);
  });

  // 注册请求根本发不出去（上游不可达）：按网络类失败定性，诊断标签不含凭据，底层错误保留在 cause 里。
  test("注册请求网络失败时按 network 定性，且错误文案不含凭据", async () => {
    const started = setup({ baseUrl: UNREACHABLE_BASE_URL });

    const failure = await bootstrapFailure();

    expect(failure).toBeInstanceOf(PlatformAccountBootstrapError);
    if (!(failure instanceof PlatformAccountBootstrapError))
      throw new Error("引导应以 PlatformAccountBootstrapError 失败");
    expect(failure.reason).toBe("registration_failed");
    expect(failure.message).toContain("network");
    expect(failure.message).not.toContain(TEST_PASSWORD);
    expect(failure.message).not.toContain(TEST_EMAIL);
    // 诊断上下文不丢：登录为什么也失败（同一台上游不可达）由 cause 给出。
    expect(failure.cause).toBeInstanceOf(UpstreamSessionUnavailableError);
    expect(started.ledger).toHaveLength(0);
  });

  // 注册不可用但账号已存在：不得因为注册被禁就拒绝一个能登录的部署——「人工建号 + 上游关注册」必须照常工作。
  test("上游禁止注册时账号若已存在，引导照常成功", async () => {
    const started = setup({
      register: () => envelope({ code: REGISTRATION_DISABLED_CODE, msg: "not allowed register" }),
    });
    registeredEmails.add(TEST_EMAIL);

    const snapshot = await bootstrapPlatformAccount();

    expect(snapshot).toMatchObject({
      platformUserId: UPSTREAM_USER_ID,
      platformSpaceId: SPACE_ID,
      status: "active",
      lastError: null,
    });
    expect(started.ledger).toHaveLength(1);
  });

  // 注册刚建号却仍登不上：账号侧动作已完成，原因仍归 session_unavailable，但文案必须点明「本次引导刚建号」。
  test("自助注册成功但登录失败时，错误文案点明刚建号", async () => {
    // 注册照常建号（返回 created），但登录一律被拒：模拟上游注册/登录的密码口径不一致这类罕见形态。
    setup({ register: () => envelope({ code: 0, msg: "success", data: { user_id_str: UPSTREAM_USER_ID } }) });

    const failure = await bootstrapFailure();

    expect(failure).toBeInstanceOf(PlatformAccountBootstrapError);
    if (!(failure instanceof PlatformAccountBootstrapError))
      throw new Error("引导应以 PlatformAccountBootstrapError 失败");
    expect(failure.reason).toBe("session_unavailable");
    expect(failure.message).toContain("刚自助注册成功");
    expect(failure.message).not.toContain(TEST_PASSWORD);
  });

  // 同进程两个执行者并发首启：注册幂等、登录由单飞收敛成一次、台账只落一行（跨副本真正同时注册的形态见引导文件注释）。
  test("同进程并发首启时注册幂等、登录单飞，台账只落一行", async () => {
    const started = setup();
    // 等待窗口压到毫秒级：万一登录租约分支被走到，用例也不会真等默认的 8 秒。
    setUpstreamSessionTimingForTests({ loginWaitMs: 200, loginWaitPollIntervalMs: 20 });

    const [first, second] = await Promise.all([bootstrapPlatformAccount(), bootstrapPlatformAccount()]);

    // 两个执行者各注册一次：一方建号（created），另一方拿到「已存在」。
    expect(started.requests.filter((item) => item.path === REGISTER_PATH)).toHaveLength(2);
    // 上游是单会话账号，两次并发登录会互相踢键，因此登录必须收敛为一次。
    expect(started.requests.filter((item) => item.path === LOGIN_PATH)).toHaveLength(1);
    // 只比身份字段：`lastLoginAt` 是各执行者各自取的时刻，两个快照的时间戳不保证相等（实测可差 1ms），
    // 整对象比较会变成随机失败的用例。
    expect(first).toMatchObject({
      platformUserId: UPSTREAM_USER_ID,
      platformSpaceId: SPACE_ID,
      email: TEST_EMAIL,
      status: "active",
    });
    expect(second.platformUserId).toBe(first.platformUserId);
    expect(started.ledger).toHaveLength(1);
  });
});
