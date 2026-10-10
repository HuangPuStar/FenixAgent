// 「台账缺行但绑定还在」这一运维状态的回归用例（对应需求方截图：列表页正常显示卡片、运行日志却报「尚未初始化」）。
//
// 状态成因（代码路径）：平台账号台账 `workflow_v2_platform_account` 是全局单行，唯一写入点是引导路径；该行一旦
// 丢失（历史库清理、库重建、迁移演练），而 `workflow_v2_org_app` 的绑定行仍在，就会出现**两条读路径前置条件
// 不一致**：列表页的门是 `GET /org-app` → `findOrgAppBinding`（只读绑定表）→ active → 渲染卡片；运行日志的门
// 是 `resolveBinding` → `findTenantBinding`（要账号行 + 绑定行都在）→ 缺账号行 → 409 `ORG_APP_NOT_BOUND`。
//
// 本文件断言修复后的三条口径（`resolveBinding` 的收敛）：
// ① 台账缺行 + 上游可用 → 按需引导把台账补回，读路径**自动恢复**（不再要求用户做他做不到的事）；
// ② 台账缺行 + 引导失败 → 503 `PLATFORM_ACCOUNT_NOT_PROVISIONED`（用户修不了的状态不得再说「去列表页初始化」，
//    那里因为已绑定根本不显示初始化按钮）；
// ③ 真正的未绑定（没有绑定行）→ 立即 409 `ORG_APP_NOT_BOUND`，且**零出站**（不为未绑定组织触发引导）。
//
// 为什么必须用假上游服务器而不是注入 `callUpstream` 替身：引导链路（注册/登录/空间列表）走的是模块级
// `callUpstream` 与真实会话/配置，注入替身只覆盖路由层的业务调用，测不到「台账补回」这条关键路径。
// 装置（真实 Postgres 句柄 + 守卫 + 前缀化清理）复用 `helpers/console-plane-harness.ts`，假上游的写法与
// `upstream-session-platform-account.test.ts` 同款（单实例、按用例换处理器）。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { Elysia } from "elysia";
import { createWebWorkflowV2Routes } from "../server/routes/web";
import { createWebWorkflowV2RunRoutes } from "../server/routes/web/workflow-runs";
import { resetUpstreamHealth } from "../server/services/upstream-health";
import { getUpstreamSession } from "../server/services/upstream-session";
import { resetUpstreamSessionStoreForTests } from "../server/services/upstream-session-store";
import { createWorkflowV2ModuleConfig } from "../server/testing";
import {
  cleanupTestRows,
  clearPlatformAccount,
  closeTestPool,
  countPlatformAccounts,
  createStubAuthGuard,
  createTestScopedDatabase,
  databaseReachable,
  installDatabase,
  ORG_A,
  OWNER_ID,
  readBody,
  readForeignPlatformAccounts,
  request,
  SPACE_ID,
  seedBinding,
  seedRecord,
  upstreamId,
} from "./helpers/console-plane-harness";

const REGISTER_PATH = "/api/passport/web/email/register/v2/";
const LOGIN_PATH = "/api/passport/web/email/login/";
const SPACE_LIST_PATH = "/api/playground_api/space/list";
const LIST_SPANS_PATH = "/api/workflow_api/list_spans";

const TEST_EMAIL = "workflow-v2-recovery@example.invalid";
const TEST_PASSWORD = "fixture-password-recovery-not-a-secret";
const COOKIE_VALUE = "session-key-recovery-fixture-a41f";

/**
 * 假上游登录响应回显的上游用户 ID。
 *
 * 必须带用例前缀：恢复出来的台账行按它落库（`platform_user_id`），不带前缀的行既躲过 `clearPlatformAccount`
 * 也躲过 `cleanupTestRows`，会以「台账已有行」的形态污染同库后续用例（实测：下一个用例会直接跳过引导，
 * 变成一次「未登录就调上游」的假失败）。
 */
const PLATFORM_USER_ID = upstreamId("recovery-account");

let upstreamServer: ReturnType<typeof Bun.serve> | null = null;
/** 假上游收到的请求路径（当前用例的）；`setup()` 就地清空，保持引用稳定。 */
const upstreamRequests: string[] = [];
/** 当前用例的处理器；未设置就发请求时立刻 500，避免静默通过。 */
let upstreamHandler: (path: string, body: unknown) => Response = () =>
  new Response("用例未设置假上游处理器", { status: 500 });

function upstreamBaseUrl(): string {
  if (upstreamServer === null) throw new Error("假上游尚未启动");
  return `http://127.0.0.1:${upstreamServer.port}`;
}

beforeAll(() => {
  upstreamServer = Bun.serve({
    port: 0,
    async fetch(request_) {
      const url = new URL(request_.url);
      upstreamRequests.push(url.pathname);
      const raw = await request_.text();
      let body: unknown = null;
      try {
        body = raw.length > 0 ? (JSON.parse(raw) as unknown) : null;
      } catch {
        body = null;
      }
      return upstreamHandler(url.pathname, body);
    },
  });
});

afterAll(async () => {
  upstreamServer?.stop(true);
  upstreamServer = null;
  await cleanupTestRows();
  await closeTestPool();
});

function envelope(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** 正常登录响应；`Set-Cookie` 的 domain 带端口（上游实测形态）。 */
function loginOk(): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data: { user_id_str: PLATFORM_USER_ID } }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `session_key=${COOKIE_VALUE}; max-age=2592000; domain=127.0.0.1:18080; path=/; HttpOnly; SameSite`,
    },
  });
}

/** 注册响应：账号已存在（引导据此幂等跳过建号，随后照常登录）。 */
const registerAlreadyExists = () => envelope({ code: 700000001, msg: "email already exist" });

/** 个人空间列表：`space_type === 1` 是个人空间。 */
const spaceListOk = () => envelope({ code: 0, data: { bot_space_list: [{ id: SPACE_ID, space_type: 1 }] } });

/** 上游 `list_spans` 的成功响应：2026-10-09 起是标准信封 `{code, msg, spans}`（旧桩时期是裸 `{spans}`）。 */
const spansOk = (spans: unknown[]) => envelope({ code: 0, msg: "", spans });

/** 一条可判读的 span：`start_time`/`duration` 是毫秒。 */
const span = (overrides: Record<string, unknown> = {}) => ({
  trace_id: "trace-recovery",
  log_id: "log-recovery",
  start_time: 1_760_000_000_000,
  duration: 1_500,
  status_code: 1,
  ...overrides,
});

let guard: ReturnType<typeof createStubAuthGuard>;

/**
 * 换上本用例的假上游处理器与模块配置（指向假上游），并让会话与熔断从**已知状态**开始。
 *
 * 不复用 `installDatabase()`：它不注入 `moduleConfigs`，而本文件必须把上游基址指向假上游（引导链路走真实
 * `callUpstream` 与真实会话）。数据库句柄仍用同一份测试库。
 *
 * 三个复位都是必要的隔离，缺一个就会与本目录其它用例互相干扰（实测：全目录一起跑时本文件曾稳定失败）：
 * - `resetAllStubs()` + `initializeTestApplicationInfrastructure`：应用基础设施与模块配置；
 * - `resetUpstreamHealth()`：熔断是**进程级单例**，其它用例驱动的失败会让它停在打开/半开态，本用例的第一次
 *   上游调用会被直接短路（表现为「引导失败」的假故障）；
 * - `resetUpstreamSessionStoreForTests()` + `getUpstreamSession().invalidate()`：会话与登录租约同样是进程级，
 *   留着别人的会话就看不到「注册 → 登录 → 空间列表」这条真实链路。
 */
function setup(handler: (path: string, body: unknown) => Response) {
  upstreamHandler = handler;
  upstreamRequests.length = 0;
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    database: createTestScopedDatabase(),
    moduleConfigs: {
      "workflow-v2": createWorkflowV2ModuleConfig({
        upstreamBaseUrl: upstreamBaseUrl(),
        accountEmail: TEST_EMAIL,
        accountPassword: TEST_PASSWORD,
      }),
    },
  });
  resetUpstreamHealth();
  resetUpstreamSessionStoreForTests();
  getUpstreamSession().invalidate();
  guard = createStubAuthGuard();
  guard.setActor({ organizationId: ORG_A, userId: OWNER_ID });
}

/** 组装运行日志路由；**不注入** `callUpstream`，让链路走真实调用（见文件头）。 */
function createApp() {
  return new Elysia().use(createWebWorkflowV2RunRoutes({ authGuardPlugin: guard.plugin }));
}

/** 上游调用链的成功处理器：注册（已存在）→ 登录 → 空间列表 → 运行 span。 */
function healthyUpstream(spans: unknown[]) {
  return (path: string): Response => {
    if (path === REGISTER_PATH) return registerAlreadyExists();
    if (path === LOGIN_PATH) return loginOk();
    if (path === SPACE_LIST_PATH) return spaceListOk();
    if (path === LIST_SPANS_PATH) return spansOk(spans);
    return new Response(`用例未覆盖的上游路径：${path}`, { status: 500 });
  };
}

describe.skipIf(!databaseReachable)("台账缺行但绑定还在时的绑定解析（真实 Postgres + 假上游）", () => {
  beforeEach(async () => {
    // 注入**带测试作用域**的句柄（见 `createTestScopedDatabase`）：台账读只看本用例前缀行，因此本机主库里的
    // 真实台账行不会让「缺行」这一前置条件失效，用例也不会去动那一行。
    installDatabase(createTestScopedDatabase());
    await seedBinding();
    // 复现报告场景：绑定行在（列表页照常显示卡片），平台账号台账（本用例作用域内）缺行。
    await clearPlatformAccount();
  });

  afterEach(() => {
    resetAllStubs();
    getUpstreamSession().invalidate();
    upstreamHandler = () => new Response("用例未设置假上游处理器", { status: 500 });
  });

  // 报告场景的回归：读路径不再把「台账缺行」当成「本组织未初始化」。按需引导补回台账后，运行记录正常返回，
  // 且上游调用带的是**引导出来的**真实 space_id（证明不是靠降级/空列表蒙混过去）。
  test("台账缺行时按需引导补回台账并正常返回运行记录", async () => {
    const record = await seedRecord("recovery-ok");
    setup(healthyUpstream([span()]));
    expect(await countPlatformAccounts()).toBe(0);

    const response = await request(createApp(), `/run-records?workflowId=${record.id}`);
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    // 运行清单由平台转发上游 `list_spans`（上游已实现；曾短暂改走只读直连库，已按 ADR 的移除条件删除）。
    // 归属与耗时取自查询主体与 span 本身（本用例的 fixture 不带 tags，因此 log/execute 身份为 null，
    // 这是映射的既定行为：上游没给就不造值）。
    expect(body.data?.items?.[0]).toMatchObject({
      workflowId: record.upstreamWorkflowId,
      workflowName: record.name,
      durationMs: 1_500,
    });
    // 台账被补回：这是自愈发生的直接证据（下一次请求不必再付引导成本）。
    expect(await countPlatformAccounts()).toBe(1);
    // 引导链路真的走过注册 → 登录 → 空间列表，再带上身份取运行记录（顺序即因果：先拿到身份与空间，
    // 才可能拼出带 space_id 的运行记录查询；中间可能夹一次账号信息探测，故用位置关系而不是全等）。
    expect(upstreamRequests[0]).toBe(REGISTER_PATH);
    expect(upstreamRequests[1]).toBe(LOGIN_PATH);
    expect(upstreamRequests.indexOf(SPACE_LIST_PATH)).toBeGreaterThan(upstreamRequests.indexOf(LOGIN_PATH));
    expect(upstreamRequests.indexOf(LIST_SPANS_PATH)).toBeGreaterThan(upstreamRequests.indexOf(SPACE_LIST_PATH));
  });

  // 引导失败时不得退回「尚未初始化工作流空间」：那是用户修不了的状态，文案会把他指到列表页——那里因为已绑定
  // 根本不显示初始化按钮。503 + 专用错误码是与事实一致的答复（前端据此给不同的下一步）。
  test("台账缺行且引导失败时返回 503 而不是未绑定 409", async () => {
    const record = await seedRecord("recovery-fail");
    setup((path) => {
      if (path === REGISTER_PATH) return registerAlreadyExists();
      if (path === LOGIN_PATH) return envelope({ code: 700000003, msg: "user info invalidate" });
      return new Response(`引导失败用例不该请求：${path}`, { status: 500 });
    });

    const response = await request(createApp(), `/run-records?workflowId=${record.id}`);
    const body = await readBody(response);

    expect(response.status).toBe(503);
    expect(body.error?.code).toBe("PLATFORM_ACCOUNT_NOT_PROVISIONED");
    expect(body.data).toBeUndefined();
    // 没有可用空间与凭据时不该去打上游业务端点。
    expect(upstreamRequests).not.toContain(LIST_SPANS_PATH);
  });

  // 真正的未绑定（没有绑定行）保持原样：立即 409 且**零出站**——为未绑定组织跑一次引导既无意义，
  // 也会让「列表页初始化」这个唯一自修入口之外的路径付出登录/注册代价。
  test("没有绑定行时立即回 409 且不触发任何上游请求", async () => {
    const unboundOrg = `${ORG_A}-unbound`;
    setup(healthyUpstream([span()]));
    guard.setActor({ organizationId: unboundOrg, userId: OWNER_ID });

    const response = await request(createApp(), "/run-records");
    const body = await readBody(response);

    expect(response.status).toBe(409);
    expect(body.error?.code).toBe("ORG_APP_NOT_BOUND");
    expect(upstreamRequests).toEqual([]);
  });

  // 发布记录与运行记录共用同一条绑定前置链：修复对两者同时生效（避免只修一条读路径留下第二套口径）。
  test("发布记录读路径同样从按需引导中恢复", async () => {
    const record = await seedRecord("recovery-publish");
    setup((path: string) => {
      if (path === REGISTER_PATH) return registerAlreadyExists();
      if (path === LOGIN_PATH) return loginOk();
      if (path === SPACE_LIST_PATH) return spaceListOk();
      // 渠道发布记录是应用级读出口（工作流级的 `list_publish_workflow` 在上游是桩实现，见
      // `services/workflow-publish-records.ts` 文件头）：本用例只关心绑定门是否走通，记录内容为空即可。
      if (path === "/api/intelligence_api/publish/publish_record_list") {
        return envelope({ code: 0, data: [] });
      }
      if (path === "/api/workflow_api/canvas") {
        return envelope({ code: 0, data: { workflow_version: "v0.0.9", workflow: { schema_json: "{}" } } });
      }
      return new Response(`用例未覆盖的上游路径：${path}`, { status: 500 });
    });

    const app = new Elysia().use(createWebWorkflowV2Routes({ authGuardPlugin: guard.plugin }));
    const response = await request(app, `/workflow-v2/workflows/${record.id}/publish-records`);
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expect(body.data?.current).toEqual({ publishedVersion: "v0.0.9" });
    expect(await countPlatformAccounts()).toBe(1);
  });

  // 本机主库上常驻着真实台账行（真实部署登录留下的），而用例要造的恰恰是「台账缺行」。这条用例同时钉两件事：
  // ① 作用域生效——有真实行时「缺行」前置条件依旧成立，恢复链路照常走完；
  // ② **不碰真实数据**——失败分支（引导失败）会走 `markPlatformAccountDegraded`，早先它没有 `where`，会把整张
  //    表标成 degraded（真实行一并中招）；本用例按行快照比对，真实行必须逐字段不变。
  test("主库存在真实台账行时用例仍能复现缺行，且不修改真实行", async () => {
    const before = await readForeignPlatformAccounts();
    const record = await seedRecord("recovery-foreign");
    setup((path) => {
      if (path === REGISTER_PATH) return registerAlreadyExists();
      // 登录失败：这条分支会调用 `markPlatformAccountDegraded`（写路径），是真实行最可能被误伤的入口。
      if (path === LOGIN_PATH) return envelope({ code: 700000003, msg: "user info invalidate" });
      return new Response(`本用例不该请求：${path}`, { status: 500 });
    });

    const response = await request(createApp(), `/run-records?workflowId=${record.id}`);

    expect(response.status).toBe(503);
    // 引导在本用例作用域内真的被触发过（自己发出过注册/登录），而不是被真实行「顶掉」。
    expect(upstreamRequests).toContain(LOGIN_PATH);
    const after = await readForeignPlatformAccounts();
    expect(after).toEqual(before);
  });
});
