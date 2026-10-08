// Workflow V2 租户 App 映射（2A）：平台账号引导 + 组织 ↔ 上游应用 绑定。
//
// 上游一律是 `Bun.serve` 起的本地假实例（响应形状按契约快照与上游源码的 thrift json tag 核对），本地一律
// 连真实 Postgres——一对一是两个唯一索引给出的存储层事实，并发收敛与跨组织隔离只有真库才作数；连不上库时
// 整组跳过（CI 无数据库服务）。测试行带 `wf2-app-test-<run>-` 前缀并自清理，凭据一律是假 fixture。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  initializeTestApplicationInfrastructure,
  resetAllStubs,
  stubIdentityDirectory,
} from "@fenix/platform-sdk/testing";
import { workflowV2OrgApp, workflowV2PlatformAccount } from "@fenix/resource-workflow-v2/db";
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Elysia } from "elysia";
import { Pool } from "pg";
import { findTenantBinding } from "../server/repositories/tenant-binding-repository";
import { createWebWorkflowV2OrgAppRoutes } from "../server/routes/web/org-app";
import {
  DEFAULT_ORG_APP_NAME,
  ensureOrgApp,
  findOrgAppBinding,
  probeOrgAppBinding,
} from "../server/services/org-app-binding";
import { bootstrapPlatformAccount, ensurePlatformAccount } from "../server/services/platform-account-bootstrap";
import { getUpstreamSession } from "../server/services/upstream-session";
import { createWorkflowV2ModuleConfig } from "../server/testing";

type Database = ReturnType<typeof drizzle>;

const CONNECTION_STRING = process.env.DATABASE_URL;
const pool = CONNECTION_STRING ? new Pool({ connectionString: CONNECTION_STRING, max: 2 }) : null;
const handle: Database | null = pool ? drizzle(pool) : null;
const databaseReachable =
  (await pool
    ?.query("SELECT 1")
    .then(() => handle !== null)
    .catch(() => false)) ?? false;
if (!databaseReachable) console.warn("[org-app-binding.test] 跳过：DATABASE_URL 未配置或本地 Postgres 不可达。");

/** 取真实句柄；只报告事实，不回显连接串（其中含凭据）。 */
function database(): Database {
  if (!handle) throw new Error("本地 Postgres 不可达，测试数据层未装配");
  return handle;
}

const TEST_PREFIX = "wf2-app-test-";
/** 本次运行的唯一后缀：避免与上一次崩溃残留的行、或并行的另一次运行相互干扰。 */
const RUN = crypto.randomUUID().slice(0, 8);
const ORG_A = `${TEST_PREFIX}${RUN}-a`;
const ORG_B = `${TEST_PREFIX}${RUN}-b`;
const USER_ID = `${TEST_PREFIX}${RUN}-user`;
/** 组织名录（`IdentityDirectory.getOrganization`）在用例里的返回：空间名应当逐字取自这里。 */
const ORG_NAMES: Record<string, string> = { [ORG_A]: "组织 A", [ORG_B]: "组织 B" };
const TEST_EMAIL = "workflow-v2-app@example.invalid";
const TEST_PASSWORD = "fixture-password-4f81-not-a-secret";

/** 上游端点（与上游源码 `backend/api/router/upstream/api.go` 的注册路径逐字一致）。 */
const PATHS = {
  login: "/api/passport/web/email/login/",
  register: "/api/passport/web/email/register/v2/",
  spaceList: "/api/playground_api/space/list",
  createApp: "/api/draftbot/create",
  appInfo: "/api/playground_api/draftbot/get_draft_bot_info",
  deleteApp: "/api/draftbot/delete",
} as const;

/** 平台账号身份与个人空间：与运行前缀绑定，便于按前缀清理账号行。 */
const UPSTREAM_USER_ID = `${TEST_PREFIX}${RUN}-upstream-user`;
const SPACE_ID = `${TEST_PREFIX}${RUN}-space`;
/** 登录下发的会话值（假 fixture；上游按它校验 Cookie，缺 Cookie 回 401）。 */
const SESSION_KEY = `session-key-${RUN}`;

/** 一次上游请求的记录：路径、Cookie 与解析后的 JSON 体。 */
interface FakeRequest {
  path: string;
  cookie: string | null;
  body: Record<string, unknown>;
}

/**
 * 假上游：整个文件共用一个实例（`beforeAll` 起、`afterAll` 停），用例只复位状态。不按用例起停的理由是端口
 * churn：`Bun.serve({ port: 0 })` 反复释放/重绑时，进程内 fetch 的连接池可能仍持有指向刚停掉的服务端的
 * keep-alive 连接，复用它只会得到网络错误。
 */
let upstreamServer: ReturnType<typeof Bun.serve> | null = null;

const upstreamRequests: FakeRequest[] = [];
/** 已建出的 App（本用例的）：`bot_id` 递增，模拟上游分配 ID。 */
const createdApps: Array<{ botId: string; name: string; spaceId: string }> = [];
const deletedAppIds: string[] = [];
/** 「已被删除」的 App：查详情返回不存在类错误。 */
const missingAppIds = new Set<string>();
/** 查详情时模拟上游不可达（panic 码）：探活必须把「不可达」与「明确不存在」分开。 */
let appInfoUnavailable = false;
/** 建 App 的响应覆盖（`null` 表示正常成功）。 */
let createResponseOverride: Response | null = null;

function upstreamBaseUrl(): string {
  if (upstreamServer === null) throw new Error("假上游尚未启动");
  return `http://127.0.0.1:${upstreamServer.port}`;
}

/** 上游信封响应。 */
function envelope(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

/** 登录成功响应；`session_key` 只在 `Set-Cookie`（上游实测形态，响应体不含凭据）。 */
function loginOk(): Response {
  const cookie = `session_key=${SESSION_KEY}; max-age=2592000; domain=127.0.0.1:18080; path=/; HttpOnly`;
  return new Response(JSON.stringify({ code: 0, msg: "success", data: { user_id_str: UPSTREAM_USER_ID } }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": cookie },
  });
}

beforeAll(() => {
  upstreamServer = Bun.serve({
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
      upstreamRequests.push({ path: url.pathname, cookie: request.headers.get("cookie"), body });

      if (url.pathname === PATHS.login) return loginOk();
      // 本文件的模型里账号本就存在（登录恒成功），因此注册恒回「邮箱已存在」：引导据此幂等跳过建号。
      // 注册的完整分支（建号 / 被禁 / 未知码 / 并发）由 `platform-account-registration.test.ts` 覆盖。
      if (url.pathname === PATHS.register) {
        return envelope({ code: 700000001, msg: "email already exist" });
      }
      // 除登录与注册外一律要求会话：与上游一致（无 Cookie 一律 401，不进入业务分支）。
      if (request.headers.get("cookie") !== `session_key=${SESSION_KEY}`) {
        return envelope({ code: 401, msg: "missing session_key in cookie" }, 401);
      }

      switch (url.pathname) {
        case PATHS.spaceList:
          // 含团队空间在前、个人空间在后：取法必须认 `space_type === 1`（上游的 SpaceType_Personal）而不是盲取 [0]。
          return envelope({
            code: 0,
            data: {
              bot_space_list: [
                { id: `${SPACE_ID}-team`, space_type: 2 },
                { id: SPACE_ID, space_type: 1 },
              ],
            },
          });
        case PATHS.createApp:
          if (createResponseOverride !== null) return createResponseOverride;
          createdApps.push({
            botId: crypto.randomUUID(),
            name: String(body.name ?? ""),
            spaceId: String(body.space_id ?? ""),
          });
          return envelope({ code: 0, data: { bot_id: createdApps[createdApps.length - 1]?.botId } });
        case PATHS.appInfo: {
          const botId = String(body.bot_id ?? "");
          if (appInfoUnavailable) return envelope({ code: 777777775, msg: "upstream panic stack" });
          const app = createdApps.find((item) => item.botId === botId);
          if (missingAppIds.has(botId) || app === undefined) {
            return envelope({ code: 100000000, msg: `invalid parameter : agent ${botId} not found` });
          }
          // 详情里的名字回显上游实际存的展示名：重绑要用它覆盖本地旧名（与上游 `bot_common.BotInfo.Name` 同口径）。
          return envelope({ code: 0, data: { bot_id: botId, bot_info: { bot_id: botId, name: app.name } } });
        }
        case PATHS.deleteApp:
          deletedAppIds.push(String(body.bot_id ?? ""));
          return envelope({ code: 0, msg: "success" });
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
});

afterAll(() => {
  upstreamServer?.stop(true);
  upstreamServer = null;
});

/** 复位假上游状态与请求记录（就地清空数组，保持引用稳定）。 */
function resetUpstream(): void {
  upstreamRequests.length = 0;
  createdApps.length = 0;
  deletedAppIds.length = 0;
  missingAppIds.clear();
  appInfoUnavailable = false;
  createResponseOverride = null;
}

/** 直接建出一个上游已存在的 App（供重绑目标、探测等用例使用）。 */
function seedUpstreamApp(name = "既有 App"): string {
  const botId = crypto.randomUUID();
  createdApps.push({ botId, name, spaceId: SPACE_ID });
  return botId;
}

/** 装配句柄与模块配置：`resetAllStubs` 必须在前——应用基础设施只允许初始化一次，不复位第二条用例就会抛错。 */
function install(injected: unknown = database()): void {
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    database: injected,
    moduleConfigs: {
      "workflow-v2": createWorkflowV2ModuleConfig({
        upstreamBaseUrl: upstreamBaseUrl(),
        accountEmail: TEST_EMAIL,
        accountPassword: TEST_PASSWORD,
      }),
    },
  });
}

/**
 * 组织名录替身：空间名取自组织名称，用例必须显式声明名录内容（`resetAllStubs` 会把它清空）。
 *
 * 传 `null` 表示「组织不存在」（目录返回 undefined），传 `"throw"` 表示名录读取故障。
 */
function stubOrgDirectory(overrides: { readonly [orgId: string]: string | null | "throw" } = {}): void {
  const table = { ...ORG_NAMES, ...overrides };
  stubIdentityDirectory({
    getOrganization: async (organizationId: string) => {
      const name = table[organizationId];
      if (name === "throw") throw new Error("identity directory unavailable");
      // 名录里查不到（或显式标 null）→ 组织不存在，按契约返回 undefined。
      if (name === undefined || name === null) return;
      return { id: organizationId, name };
    },
  });
}

/**
 * 故障注入句柄：前 N 次 `select` 返回空集（模拟另一个进程刚写入、本进程读快照还看不到）。替身链止于
 * `.limit()` 并直接给真 Promise——被测查询都以 `.limit(1)` 收尾，不需要自造 thenable（那是 `noThenProperty`
 * 禁止的形态，也让 await 语义变得难读）。
 */
function createFaultyHandle(missingSelects: number): unknown {
  let selectCount = 0;
  const emptySelect = (): unknown => {
    const rows = Promise.resolve([] as unknown[]);
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => rows,
    };
    return chain;
  };
  return new Proxy(database(), {
    get(target, property) {
      if (property === "select" && selectCount < missingSelects) {
        selectCount += 1;
        return emptySelect;
      }
      return Reflect.get(target, property, target);
    },
  });
}

/** 会话守卫替身写入 `store.authContext` 的最小主体；与三个 handler 消费的字段同形。 */
interface StubActor {
  organizationId: string;
  userId: string;
  role: string;
}

/** 会话守卫替身：只提供工厂注册路由所需的 `sessionAuth` 宏与 `store.authContext`。 */
function createStubAuthGuard() {
  let actor: StubActor | null = null;
  const plugin = new Elysia({ name: "wf2-org-app-test-guard" }).state({ authContext: null as StubActor | null }).macro({
    sessionAuth(enabled: boolean) {
      if (!enabled) return {};
      return {
        beforeHandle({ store }: { store: { authContext: StubActor | null } }) {
          if (actor) store.authContext = actor;
        },
      };
    },
  });
  return {
    plugin,
    setActor(next: StubActor | null) {
      actor = next;
    },
  };
}

/** 清掉本文件写过的测试数据；只看前缀，绝不触碰既有行。 */
async function cleanupTestRows(): Promise<void> {
  await database()
    .delete(workflowV2OrgApp)
    .where(like(workflowV2OrgApp.organizationId, `${TEST_PREFIX}%`));
  await database()
    .delete(workflowV2PlatformAccount)
    .where(like(workflowV2PlatformAccount.platformUserId, `${TEST_PREFIX}%`));
}

/** 读本组织（或本前缀账号）的行；断言用，绕过服务层。 */
const orgAppRows = (organizationId: string) =>
  database().select().from(workflowV2OrgApp).where(eq(workflowV2OrgApp.organizationId, organizationId));
const accountRows = () =>
  database()
    .select()
    .from(workflowV2PlatformAccount)
    .where(like(workflowV2PlatformAccount.platformUserId, `${TEST_PREFIX}%`));

// 行清理只在 beforeEach 里做（那里也覆盖「上一次运行崩溃留下的前缀行」）；收尾只关连接池，
// 避免把清理排在「假上游已停」之后这种钩子顺序耦合上。
afterAll(async () => {
  await pool?.end();
});

interface WebBody {
  readonly success: boolean;
  readonly data?: { readonly appId?: string | null; readonly status?: string; readonly ok?: boolean };
  readonly error?: { readonly code: string };
}

describe.skipIf(!databaseReachable)("workflow-v2 租户 App 映射（真实 Postgres + 假上游）", () => {
  const guard = createStubAuthGuard();
  let app: ReturnType<typeof createWebWorkflowV2OrgAppRoutes>;

  const request = (path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init));
  const jsonInit = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  /** 三个接口共用同一调用形状：状态码 + 信封。 */
  async function call(path: string, init?: RequestInit): Promise<{ status: number; body: WebBody }> {
    const response = await request(path, init);
    return { status: response.status, body: (await response.json()) as WebBody };
  }
  /** 初始化是**无入参**的一键动作：请求不带请求体。 */
  const postOrgApp = () => call("/org-app", { method: "POST" });
  const postRebind = (appId: string) => call("/org-app/rebind", jsonInit({ appId }));

  beforeEach(async () => {
    install();
    // 名录替身必须在 install 之后：`resetAllStubs` 会把上一条用例的身份目录覆盖清空。
    stubOrgDirectory();
    await cleanupTestRows();
    resetUpstream();
    getUpstreamSession().invalidate();
    guard.setActor({ organizationId: ORG_A, userId: USER_ID, role: "owner" });
    app = createWebWorkflowV2OrgAppRoutes({ authGuardPlugin: guard.plugin });
  });

  afterEach(resetAllStubs);

  // 平台账号是单行表：首次引导写入身份与个人空间（个人空间按 space_type 认，不盲取 [0]），重复引导就地更新。
  test("引导平台账号写入身份与个人空间，重复引导不产生第二行", async () => {
    const first = await bootstrapPlatformAccount();
    expect(first.platformUserId).toBe(UPSTREAM_USER_ID);
    expect(first.platformSpaceId).toBe(SPACE_ID);
    expect(first.email).toBe(TEST_EMAIL);
    expect(first.status).toBe("active");
    expect(first.lastLoginAt).toBeInstanceOf(Date);
    const second = await bootstrapPlatformAccount();
    expect(second.platformUserId).toBe(UPSTREAM_USER_ID);
    expect(second.platformSpaceId).toBe(SPACE_ID);
    const rows = await accountRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.lastError).toBeNull();
  });

  // 反垃圾账号护栏：台账已有行时引导入口不做事——一个上游请求都不发，更不会注册（否则 env 邮箱写错会凭空建号）。
  test("台账已有账号行时 ensurePlatformAccount 不注册也不登录", async () => {
    const seededUserId = `${TEST_PREFIX}${RUN}-existing-upstream-user`;
    const seededSpaceId = `${TEST_PREFIX}${RUN}-existing-space`;
    await database()
      .insert(workflowV2PlatformAccount)
      .values({
        platformUserId: seededUserId,
        platformSpaceId: seededSpaceId,
        email: TEST_EMAIL,
        status: "active",
        lastLoginAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      });

    const account = await ensurePlatformAccount();

    // 读的是台账（不是现场引导出来的身份），且整条路径零出站：注册与登录都在引导里，两者都不该被触达。
    expect(account.platformUserId).toBe(seededUserId);
    expect(account.platformSpaceId).toBe(seededSpaceId);
    expect(upstreamRequests.filter((item) => item.path === PATHS.register)).toHaveLength(0);
    expect(upstreamRequests).toHaveLength(0);
  });

  // 首次使用即引导：POST /org-app 在建 App 前完成「登录 → 取个人空间 → 落库账号」，space_id 由服务端注入。
  test("POST /org-app 首次调用建 App 并绑定，注入平台 space_id", async () => {
    const { status, body } = await postOrgApp();
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(createdApps).toHaveLength(1);
    expect(createdApps[0]?.spaceId).toBe(SPACE_ID);
    const createRequest = upstreamRequests.find((item) => item.path === PATHS.createApp);
    expect(createRequest?.body.icon_uri).toBe("default_icon/default_app_icon.png");
    expect(typeof createRequest?.body.description).toBe("string");
    const rows = await orgAppRows(ORG_A);
    expect(rows).toHaveLength(1);
    expect(body.data?.appId).toBe(rows[0]?.appId);
    expect(rows[0]?.status).toBe("active");
    expect((await accountRows())[0]?.platformSpaceId).toBe(SPACE_ID);
  });

  // 空间名 = 组织名称：用户点一下就走完，名称由服务端从身份目录取，前端没有任何可提交的名称。
  test("空间名取自组织名称，请求体里的名称一律被忽略", async () => {
    // 模拟「客户端硬塞一个名称」：路由没有该入参，Elysia 直接丢弃请求体，绝不会流进上游或本地行。
    const { status, body } = await call(
      "/org-app",
      jsonInit({ name: "前端指定的名字", organizationId: ORG_B, appId: "fake-app" }),
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(createdApps).toHaveLength(1);
    expect(createdApps[0]?.name).toBe(ORG_NAMES[ORG_A]);
    expect((await orgAppRows(ORG_A))[0]?.name).toBe(ORG_NAMES[ORG_A]);
    // 组织谓词同样只认会话：请求体里的 organizationId 不得改变归属。
    expect(await orgAppRows(ORG_B)).toHaveLength(0);
  });

  // 名称为空（组织名为纯空白）时的确定行为：回退到固定默认名，而不是让初始化失败或落一个空名字。
  test("组织名称为空白时回退默认展示名", async () => {
    stubOrgDirectory({ [ORG_A]: "   " });
    const { status } = await postOrgApp();
    expect(status).toBe(200);
    expect(createdApps[0]?.name).toBe(DEFAULT_ORG_APP_NAME);
    expect((await orgAppRows(ORG_A))[0]?.name).toBe(DEFAULT_ORG_APP_NAME);
  });

  // 名录故障/组织不存在同样是确定行为：名称只是展示字段，读不到不该把「一键初始化」变成一次失败。
  test("组织名录读取失败或组织不存在时回退默认展示名并照常建绑", async () => {
    stubOrgDirectory({ [ORG_A]: "throw" });
    const failed = await postOrgApp();
    expect(failed.status).toBe(200);
    expect(createdApps[0]?.name).toBe(DEFAULT_ORG_APP_NAME);

    // 换一个「名录查不到」的组织再跑一遍：两条分支都要落默认名，且都真的完成了绑定。
    await cleanupTestRows();
    resetUpstream();
    stubOrgDirectory({ [ORG_B]: null });
    guard.setActor({ organizationId: ORG_B, userId: USER_ID, role: "owner" });
    const missing = await postOrgApp();
    expect(missing.status).toBe(200);
    expect(createdApps[0]?.name).toBe(DEFAULT_ORG_APP_NAME);
    expect(await orgAppRows(ORG_B)).toHaveLength(1);
  });

  // 幂等：已绑定后再调用不得再建 App（重复点击、前端重放都会走到这条路径）。
  test("重复调用 POST /org-app 幂等，不重复建 App", async () => {
    const first = await postOrgApp();
    const second = await postOrgApp();
    expect(second.body.data?.appId).toBe(first.body.data?.appId);
    expect(createdApps).toHaveLength(1);
    expect(await orgAppRows(ORG_A)).toHaveLength(1);
  });

  // 并发首次调用：进程内单飞让两个调用共享同一次创建，只在上游建一个 App。
  test("并发首次调用只建一个 App", async () => {
    const [first, second] = await Promise.all([ensureOrgApp(ORG_A), ensureOrgApp(ORG_A)]);
    expect(first.appId).toBe(second.appId);
    expect(createdApps).toHaveLength(1);
    expect(await orgAppRows(ORG_A)).toHaveLength(1);
  });

  // 跨进程并发（读快照看不到对方刚写的行）：唯一索引只让一行落库，落败者收敛到既有绑定并清掉自己的孤儿 App。
  test("唯一索引冲突后收敛到既有绑定，并清理孤儿 App", async () => {
    const seeded = await ensureOrgApp(ORG_A);
    const createsBefore = createdApps.length;

    // 前两次 select 置空：路由/服务的前置查询与单飞内的二次检查都读不到既有行，插入将真的撞唯一索引。
    install(createFaultyHandle(2));
    stubOrgDirectory();
    const converged = await ensureOrgApp(ORG_A);
    expect(converged.appId).toBe(seeded.appId);
    expect(createdApps).toHaveLength(createsBefore + 1);
    expect(deletedAppIds).toEqual([createdApps[createdApps.length - 1]?.botId]);
    const rows = await orgAppRows(ORG_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.appId).toBe(seeded.appId);
  });

  // 跨组织隔离：绑定按组织谓词读取，A 的绑定不得出现在 B；B 建自己的 App 时只多一行。
  test("跨组织互不可见，各自建自己的 App", async () => {
    const bindingA = await ensureOrgApp(ORG_A);
    guard.setActor({ organizationId: ORG_B, userId: USER_ID, role: "owner" });
    expect((await call("/org-app")).body.data).toEqual({ appId: null, status: "unbound" });
    const bindingB = await ensureOrgApp(ORG_B);
    expect(bindingB.appId).not.toBe(bindingA.appId);
    expect(await orgAppRows(ORG_A)).toHaveLength(1);
    expect(await orgAppRows(ORG_B)).toHaveLength(1);
  });

  // 重绑是管理动作：member 一律 403，且不得触达上游或改动绑定。
  test("非管理员调 rebind 被拒且不触达上游", async () => {
    const binding = await ensureOrgApp(ORG_A);
    guard.setActor({ organizationId: ORG_A, userId: USER_ID, role: "member" });
    const requestsBefore = upstreamRequests.length;
    const { status, body } = await postRebind(seedUpstreamApp());
    expect(status).toBe(403);
    expect(body.error?.code).toBe("FORBIDDEN");
    expect(upstreamRequests).toHaveLength(requestsBefore);
    expect((await orgAppRows(ORG_A))[0]?.appId).toBe(binding.appId);
  });

  // 管理员重绑：目标确认存在后写库并回到 active（换 App 是该租户的显式动作，不是隐式覆盖）。
  test("管理员重绑到存在的 App 生效并回到 active", async () => {
    await ensureOrgApp(ORG_A);
    const target = seedUpstreamApp("目标 App");
    const { status, body } = await postRebind(target);
    expect(status).toBe(200);
    expect(body.data?.ok).toBe(true);
    const rows = await orgAppRows(ORG_A);
    expect(rows[0]?.appId).toBe(target);
    expect(rows[0]?.name).toBe("目标 App");
    expect(rows[0]?.status).toBe("active");
  });

  // 目标不存在时拒绝重绑：把不存在的 App 写进绑定表会制造「看起来绑好了、用起来全失败」的租户。
  test("重绑到不存在的 App 返回 404 且绑定不变", async () => {
    const binding = await ensureOrgApp(ORG_A);
    const { status, body } = await postRebind(`${TEST_PREFIX}${RUN}-missing-app`);
    expect(status).toBe(404);
    expect(body.error?.code).toBe("NOT_FOUND");
    expect((await orgAppRows(ORG_A))[0]?.appId).toBe(binding.appId);
  });

  // 目标已被别的组织占用：409 拒绝且不回显占用方（否则跨租户存在性变成探测面）。
  test("重绑到别的组织已占用的 App 返回 409 且不泄漏占用方", async () => {
    const bindingB = await ensureOrgApp(ORG_B);
    const response = await request("/org-app/rebind", jsonInit({ appId: bindingB.appId }));
    const raw = await response.text();
    expect(response.status).toBe(409);
    expect((JSON.parse(raw) as { error: { code: string } }).error.code).toBe("CONFLICT");
    expect(raw).not.toContain(ORG_B);
  });

  // 上游建 App 失败的两种形态都不得落半截数据：业务码拒绝与响应缺 bot_id 同样算失败（502），本地零行。
  test("上游拒绝或响应缺 bot_id 时都不落库", async () => {
    createResponseOverride = envelope({ code: 400, msg: "space id is required" });
    const rejected = await postOrgApp();
    expect(rejected.status).toBe(502);
    expect(rejected.body.error?.code).toBe("UPSTREAM_REJECTED");
    createResponseOverride = envelope({ code: 0, data: {} });
    expect((await postOrgApp()).status).toBe(502);
    expect(await orgAppRows(ORG_A)).toHaveLength(0);
    expect(deletedAppIds).toHaveLength(0);
  });

  // App 被删后的降级与恢复：明确不存在 → degraded（上层据此快速失败）；确认存在 → 回到 active。
  test("探测到 App 不存在时置 degraded，确认存在后恢复 active", async () => {
    const binding = await ensureOrgApp(ORG_A);
    missingAppIds.add(binding.appId);
    expect((await probeOrgAppBinding(ORG_A)).kind).toBe("degraded");
    expect((await orgAppRows(ORG_A))[0]?.status).toBe("degraded");
    // 上层（2B 的绑定读取）据此快速失败：写接口在 degraded 时直接 503，不打上游。
    expect((await findTenantBinding(ORG_A))?.appStatus).toBe("degraded");
    missingAppIds.delete(binding.appId);
    expect((await probeOrgAppBinding(ORG_A)).kind).toBe("active");
    expect((await orgAppRows(ORG_A))[0]?.status).toBe("active");
  });

  // 上游不可达不是「App 被删」：探测必须保持原状态，避免一次超时把绑定变成需要人工重绑的事故。
  test("上游不可达时探测不改绑定状态", async () => {
    await ensureOrgApp(ORG_A);
    appInfoUnavailable = true;
    expect((await probeOrgAppBinding(ORG_A)).kind).toBe("unknown");
    expect((await orgAppRows(ORG_A))[0]?.status).toBe("active");
  });

  // 读接口不打上游：GET /org-app 只读本地，状态展示依赖已被探测收敛的结果。
  test("GET /org-app 读本地且不回显未绑定组织的行", async () => {
    await ensureOrgApp(ORG_A);
    const requestsBefore = upstreamRequests.length;
    const { status, body } = await call("/org-app");
    expect(status).toBe(200);
    expect(body.data?.status).toBe("active");
    expect(body.data?.appId).toBe((await findOrgAppBinding(ORG_A))?.appId ?? "");
    expect(upstreamRequests).toHaveLength(requestsBefore);
  });

  // 身份只取会话上下文：守卫没写入时一律 401，不因为「客户端说自己是哪个组织」而放行。
  test("缺少会话上下文时三个接口都返回 401", async () => {
    guard.setActor(null);
    const responses = await Promise.all([
      request("/org-app"),
      request("/org-app", { method: "POST" }),
      request("/org-app/rebind", jsonInit({ appId: "whatever" })),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
    expect(await orgAppRows(ORG_A)).toHaveLength(0);
  });
});
