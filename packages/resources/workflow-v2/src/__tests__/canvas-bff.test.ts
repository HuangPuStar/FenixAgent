// 画布透传面（1D）的行为契约测试：冻结 §6 的透传规则（票据门、归属门、注入白名单、原样回传、panic 脱敏、
// 时间戳不换算）、§6.1 的存储直链改写、§7 的票据协议（兑换 / 续期 / 撤销）与 3A 的调试运行轮询预算。
//
// 上游一律用 `Bun.serve` 起的本地假上游，只验证**我方行为**（真实上游形态见契约快照
// `docs/design/2026-09-29-workflow-v2-upstream-contract-snapshot.md`）；数据库走链式替身，行按谓词里绑定的参数
// 过滤，组织谓词因此真的生效——跨组织用例是在测隔离，而不是在测一个恒真的替身。
//
// 凭据纪律：本文件不出现任何凭据字面量——账号密码与票据签名密钥由 `createWorkflowV2ModuleConfig()` 运行期
// 生成，会话值同样运行期生成；登录腿的请求体（含账号密码）一概不记录、不断言。

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { workflowV2OrgApp, workflowV2PlatformAccount, workflowV2Workflow } from "@fenix/resource-workflow-v2/db";
import { createCanvasBffRoutes } from "../server/routes/canvas/bff";
import {
  GET_PROCESS_CACHE_TTL_MS,
  resetGetProcessBudget,
  resetRateLimitBuckets,
} from "../server/services/canvas-passthrough";
import { issueCode, redeemCode, verifyTicket } from "../server/services/iframe-ticket";
import { getUpstreamSession } from "../server/services/upstream-session";
import { createWorkflowV2ModuleConfig } from "../server/testing";

/** 本面挂载前缀（与 `routes/canvas/bff.ts` 的 Elysia prefix 一致）与票据头名（冻结 §7）。 */
const BFF_PREFIX = "/workflow-canvas/bff";
const CANVAS_TICKET_HEADER = "x-fenix-workflow-ticket";
const USER_ID = "user-fixture-bff";
const ORG_A = "org-fixture-a";
const ORG_B = "org-fixture-b";
const WF_A = "wf-fixture-a";
const WF_B = "wf-fixture-b";
/** 租户绑定快照里的权威值：客户端无论自报什么，上游都必须收到这两个。 */
const SPACE_ID = "space-fixture-1";
const APP_ID = "app-fixture-1";
/** 上游 panic 业务码；「会话失效」是 HTTP 200 + 业务码而非 401（设计 §9.1.1 第 1 条）。 */
const PANIC_CODE = 777777775;
const AUTH_FAILED_CODE = 700012006;
/** 存储域 origin：与上游自身 origin 不同，正是必须改写直链的原因（冻结 §6.1）。 */
const STORAGE_ORIGIN = "http://127.0.0.1:9000";
/** 运行期生成的假会话值：源码里不放凭据字面量，又足以断言出站注入。 */
const COOKIE_VALUE = `session-key-fixture-${crypto.randomUUID()}`;

// ── 假上游 ──

/** 假上游记录的一条请求；`body` 为 null 即没带请求体（GET 面必须如此）。登录腿的体含账号密码，不记录。 */
interface RecordedRequest {
  method: string;
  path: string;
  cookie: string | null;
  body: unknown;
}

type UpstreamHandler = (request: RecordedRequest) => Response | Promise<Response>;

/** JSON 响应；`set-cookie` 只在登录腿出现（上游实测形态带端口的非法 domain，见 1B 的解析理由）。 */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
/** 上游成功信封。 */
function envelope(data: unknown): Response {
  return jsonResponse({ code: 0, msg: "success", data });
}
/** 登录腿的成功响应（失败形态由用例的 handler 决定）。 */
function loginOk(): Response {
  return jsonResponse({ code: 0, msg: "success" }, 200, {
    "set-cookie": `session_key=${COOKIE_VALUE}; max-age=2592000; path=/`,
  });
}
/** 未设置处理器就发请求时立刻以 500 暴露，而不是静默返回空响应。 */
function unsetHandler(): Response {
  return new Response("用例未设置假上游处理器", { status: 500 });
}
/** 失败分支的固定形状：上游信封 `{code, msg}`，且 code 与 HTTP 状态同值。 */
async function expectFailure(response: Response, status: number, msg: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ code: status, msg });
}

let upstreamServer: ReturnType<typeof Bun.serve> | null = null;
let upstreamHandler: UpstreamHandler = unsetHandler;
let loginResponder: () => Response = loginOk;
/** 本用例收到的上游请求；`setup()` 就地清空，保持引用稳定。 */
const requests: RecordedRequest[] = [];

/** 读请求体并留档；登录腿的体含账号密码，不解析也不保留。 */
async function recordRequest(request: Request): Promise<RecordedRequest> {
  const url = new URL(request.url);
  const isLogin = url.pathname.startsWith("/api/passport/");
  const raw = request.method === "GET" ? "" : await request.text();
  let body: unknown = null;
  if (!isLogin && raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  return { method: request.method, path: `${url.pathname}${url.search}`, cookie: request.headers.get("cookie"), body };
}

beforeAll(() => {
  upstreamServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const recorded = await recordRequest(request);
      requests.push(recorded);
      return recorded.path.startsWith("/api/passport/") ? loginResponder() : upstreamHandler(recorded);
    },
  });
});
afterAll(() => {
  upstreamServer?.stop(true);
  upstreamServer = null;
});
afterEach(() => {
  resetAllStubs();
  upstreamHandler = unsetHandler;
  loginResponder = loginOk;
});

/** 假上游基址；未启动即使用说明用例顺序错了。 */
function upstreamBaseUrl(): string {
  if (upstreamServer === null) throw new Error("假上游尚未启动");
  return `http://127.0.0.1:${upstreamServer.port}`;
}

// ── 数据库替身与装配 ──

/** 递归取 Drizzle 条件里绑定参数的字面值（`Param` 叶子）；依赖 Drizzle 内部 chunk 形状，故各包用例各留一份。 */
function collectParamValues(node: unknown, values: string[] = []): string[] {
  if (node === null || typeof node !== "object") return values;
  const chunks = (node as { queryChunks?: readonly unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) collectParamValues(chunk, values);
    return values;
  }
  const candidate = node as { value?: unknown; encoder?: unknown };
  if (candidate.encoder !== undefined && candidate.value !== undefined) values.push(String(candidate.value));
  return values;
}

/**
 * 链式 DB 替身：`select → from → (where|orderBy) → limit`（透传面只经这两条只读路径碰库）。
 *
 * 行按条件里**绑定的参数值**过滤（`where` 回调不执行）：组织谓词的下推因此真的生效，「跨组织 → 404」是在测
 * 隔离。行只带这两条读路径消费的列，将来新增消费列时替身给出 undefined，用例会因此变红而不是静默通过。
 */
function canvasDatabaseStub(fixture: {
  workflows?: unknown[];
  account?: unknown[];
  app?: unknown[];
}): Record<string, unknown> {
  const rowsOf = (table: unknown): unknown[] => {
    if (table === workflowV2Workflow) return fixture.workflows ?? [];
    if (table === workflowV2PlatformAccount) return fixture.account ?? [];
    if (table === workflowV2OrgApp) return fixture.app ?? [];
    return [];
  };
  // 谓词只绑身份列（组织、upstream workflow id）：绑定的每个值都必须命中行的某一列，跨组织行才会被排除。
  const matches = (row: unknown, condition: unknown): boolean => {
    const bound = collectParamValues(condition);
    if (bound.length === 0 || typeof row !== "object" || row === null) return true;
    return bound.every((value) => Object.values(row).includes(value));
  };
  return {
    select: () => ({
      from: (table: unknown) => {
        const scoped = (condition?: unknown) =>
          condition === undefined ? rowsOf(table) : rowsOf(table).filter((row) => matches(row, condition));
        return {
          where: (condition: unknown) => ({ limit: () => Promise.resolve(scoped(condition)) }),
          orderBy: () => ({ limit: () => Promise.resolve(scoped()) }),
          limit: () => Promise.resolve(scoped()),
        };
      },
    }),
  };
}

/** 注册表行 fixture：列与 `toRecord` 消费的字段一一对应。 */
function workflowRow(organizationId: string, upstreamWorkflowId: string) {
  return {
    id: `row-${upstreamWorkflowId}`,
    organizationId,
    upstreamWorkflowId,
    appId: APP_ID,
    name: `工作流 ${upstreamWorkflowId}`,
    ownerUserId: USER_ID,
    visibility: "private",
    publishedVersion: null,
    syncState: "active",
  };
}

interface SetupOptions {
  workflows?: unknown[];
  account?: unknown[];
  app?: unknown[];
  upstreamTimeoutMs?: number;
  /** 令牌桶阈值（每分钟）；用例用小阈值把限流逼到边界，默认走 fixture 的大阈值（等于不限流）。 */
  bffRateLimitPerMinute?: number;
  sessionRateLimitPerMinute?: number;
  login?: () => Response;
}
type CanvasBffApp = ReturnType<typeof createCanvasBffRoutes>;

/**
 * 装配被测路由：复位替身 → 注入链式 DB 替身与模块配置 → 作废会话与兑换限速窗口。
 *
 * `database` 必须在这里显式交给应用基础设施：它持有的是**引用**，初始化后再登记替身不会改变已注入的句柄。
 */
function setup(handler: UpstreamHandler, options: SetupOptions = {}): CanvasBffApp {
  requests.length = 0;
  upstreamHandler = handler;
  loginResponder = options.login ?? loginOk;
  // 替身与应用基础设施都是进程级：不先复位，上一用例的 DB 句柄与模块配置会泄漏进来。
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    database: canvasDatabaseStub({
      workflows: options.workflows ?? [workflowRow(ORG_A, WF_A)],
      account: options.account ?? [{ platformSpaceId: SPACE_ID, status: "active" }],
      app: options.app ?? [{ organizationId: ORG_A, appId: APP_ID, status: "active" }],
    }),
    moduleConfigs: {
      "workflow-v2": createWorkflowV2ModuleConfig({
        upstreamBaseUrl: upstreamBaseUrl(),
        // 只在需要时覆盖：fixture 是「默认值 + 覆盖」的浅合并，显式传 undefined 会把默认值抹掉。
        ...(options.upstreamTimeoutMs === undefined ? {} : { upstreamTimeoutMs: options.upstreamTimeoutMs }),
        ...(options.bffRateLimitPerMinute === undefined
          ? {}
          : { bffRateLimitPerMinute: options.bffRateLimitPerMinute }),
        ...(options.sessionRateLimitPerMinute === undefined
          ? {}
          : { sessionRateLimitPerMinute: options.sessionRateLimitPerMinute }),
      }),
    },
  });
  resetRateLimitBuckets();
  // 轮询预算同样是包内单例：不复位会让上一条用例的回放窗口漏进本用例，断言到的「上游请求数」就不真了。
  resetGetProcessBudget();
  // 会话是包内单例：用例之间必须显式作废，否则会拿到上一条用例（或上一个测试文件）的会话值。
  getUpstreamSession().invalidate();
  return createCanvasBffRoutes();
}

interface CallOptions {
  method?: string;
  ticket?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
}

/** 对被测路由发一次请求；有 body 时按 JSON 发（上游只在 POST + application/json 下绑请求体）。 */
function call(app: CanvasBffApp, path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.ticket) headers[CANVAS_TICKET_HEADER] = options.ticket;
  const hasBody = options.body !== undefined;
  if (hasBody) headers["content-type"] = "application/json";
  return app.handle(
    new Request(`http://console.invalid${path}`, {
      method: options.method ?? "POST",
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
    }),
  );
}
/** `/api/workflow_api/<endpoint>` 的 BFF 路径。 */
function upstreamPath(endpoint: string): string {
  return `${BFF_PREFIX}/api/workflow_api/${endpoint}`;
}
/** 本次用例里的业务上游请求（排除登录腿）。 */
function apiCalls(): RecordedRequest[] {
  return requests.filter((request) => !request.path.startsWith("/api/passport/"));
}
/** 取本次用例里唯一的一条业务上游请求；多于一条即断言失败。 */
function onlyApiCall(): RecordedRequest {
  const calls = apiCalls();
  expect(calls).toHaveLength(1);
  return calls[0];
}
/** 走 1C 的真实签发链路取票据（兑换端点另有专门用例，这里只借它构造合法凭据）。 */
function mintTicket(orgId: string, workflowId: string, userId: string = USER_ID): string {
  const { code } = issueCode({ userId, orgId, workflowId });
  const redeemed = redeemCode(code);
  if (redeemed === null) throw new Error("票据兑换失败：1C 的签发与兑换不同步");
  return redeemed.ticket;
}
/** 篡改票据末尾字符（结构不变、签名不符）：验签必须拒绝。 */
function tamper(ticket: string): string {
  return `${ticket.slice(0, -1)}${ticket.endsWith("A") ? "B" : "A"}`;
}

describe("canvas-bff 票据门与归属门", () => {
  // 无票、坏票与篡改票据都必须得到**真实 HTTP 401** + ticket_invalid：画布侧只在 response.status === 401
  // 时触发换票，HTTP 200 + code 401 会落进业务错误分支而永不换票（冻结 §7）。未过门的请求不得触上游。
  test("无票、坏票与篡改票据 → 真实 HTTP 401", async () => {
    const app = setup(() => envelope({}));
    for (const ticket of [null, "not-a-ticket", tamper(mintTicket(ORG_A, WF_A))]) {
      await expectFailure(
        await call(app, upstreamPath("canvas"), { ticket, body: { workflow_id: WF_A } }),
        401,
        "ticket_invalid",
      );
    }
    expect(requests).toHaveLength(0);
  });

  // 按需放行的三条只读元数据端点：**精确匹配 + 仅 POST**（冻结 §6 的 2026-09-30 增补）。放行它们是因为
  // 画布首屏会调、直连上游回 200；同一命名空间下的兄弟路径与 GET 面必须继续 404——按前缀放行等于把三个
  // 上游命名空间交给画布。
  test("按需放行的元数据端点精确匹配，兄弟路径与方法一律 404", async () => {
    const app = setup(() => envelope({ code: 0, data: {} }));
    const ticket = mintTicket(ORG_A, WF_A);
    const allowed = ["/api/bot/get_type_list", "/api/memory/variable/get_meta", "/api/passport/account/info/v2/"];
    for (const path of allowed) {
      const response = await call(app, `${BFF_PREFIX}${path}`, { ticket, body: {} });
      expect(response.status).toBe(200);
    }
    const rejected: Array<[string, CallOptions]> = [
      // 同命名空间下的兄弟路径 / 近似路径
      [`${BFF_PREFIX}/api/passport/account/info/v3/`, { ticket, body: {} }],
      [`${BFF_PREFIX}/api/bot/get_type_list_v2`, { ticket, body: {} }],
      [`${BFF_PREFIX}/api/memory/variable/get_meta_extra`, { ticket, body: {} }],
      // 命名空间根（前缀放行会误开的面）
      [`${BFF_PREFIX}/api/passport/`, { ticket, body: {} }],
      [`${BFF_PREFIX}/api/bot/`, { ticket, body: {} }],
      [`${BFF_PREFIX}/api/memory/`, { ticket, body: {} }],
      // 方法面：只读元数据端点只接受 POST
      [`${BFF_PREFIX}/api/bot/get_type_list`, { ticket, method: "GET" }],
      [`${BFF_PREFIX}/api/passport/account/info/v2/`, { ticket, method: "GET" }],
    ];
    for (const [path, options] of rejected) await expectFailure(await call(app, path, options), 404, "not_found");
  });

  // 两类 404 门：白名单外路径 / 端点空段 / 非 GET/POST 方法（本面只开三条前缀，冻结 §6），以及显式身份与
  // 票据不一致（含批量列表与非标量形态）。一律 404 而非 403——403 会把「存在但无权限」变成探测面。
  test("白名单外路径与不一致的 workflow 身份 → 404", async () => {
    const app = setup(() => envelope({}));
    const ticket = mintTicket(ORG_A, WF_A);
    const body = { workflow_id: WF_A };
    const attempts: Array<[string, CallOptions]> = [
      [upstreamPath("canvas"), { ticket, method: "PATCH", body }],
      [`${BFF_PREFIX}/api/playground_api/get_draft_bot_info`, { ticket, body }],
      [`${BFF_PREFIX}/api/workflow_api/`, { ticket, body }],
      [`${BFF_PREFIX}/api/permission_api/pat/create_personal_access_token_and_permission`, { ticket, body }],
      [upstreamPath("canvas"), { ticket, body: { workflow_id: WF_B } }],
      [`${upstreamPath("get_process")}?workflow_id=${WF_B}`, { ticket, method: "GET" }],
      [upstreamPath("workflow_detail"), { ticket, body: { workflow_ids: [WF_A, WF_B] } }],
      [upstreamPath("batch_delete"), { ticket, body: { workflow_id_list: [WF_B] } }],
      [upstreamPath("canvas"), { ticket, body: { workflow_id: 123 } }],
    ];
    for (const [path, options] of attempts) await expectFailure(await call(app, path, options), 404, "not_found");
    expect(requests).toHaveLength(0);
  });

  // 本地注册表是归属的唯一依据：票据的 org 与行归属不同（跨组织）、或行已不可见（软删 / 未登记）时一律 404。
  // 上游只验空间成员、不验 workflow ↔ App 归属，因此这道门漏了就是跨租户读写（设计 §3.3）。
  test("跨组织与不可见的 workflow → 404", async () => {
    const crossOrg = setup(() => envelope({}), { workflows: [workflowRow(ORG_B, WF_B)] });
    await expectFailure(
      await call(crossOrg, upstreamPath("canvas"), { ticket: mintTicket(ORG_A, WF_B), body: { workflow_id: WF_B } }),
      404,
      "not_found",
    );
    // 同组织但注册表里没有这一行（软删后就是这一形态）：与「不存在」同形，不给存在性探测面。
    const missing = setup(() => envelope({}), { workflows: [] });
    await expectFailure(
      await call(missing, upstreamPath("canvas"), { ticket: mintTicket(ORG_A, WF_A), body: { workflow_id: WF_A } }),
      404,
      "not_found",
    );
    expect(requests).toHaveLength(0);
  });
});

describe("canvas-bff 注入与响应后处理", () => {
  // 客户端自报的空间/App/Agent 身份一律剥离，仅注入权威 space_id/project_id，避免混用互斥执行上下文。
  // 响应原样回传上游信封与 HTTP 状态——业务错误同一规则，折叠成 200 会让画布把错误当成功、包装成
  // {success,data} 会打断画布 SDK（冻结 §6）。
  test("注入权威空间/App、剥离客户端伪造值、原样回传信封", async () => {
    const okEnvelope = { code: 0, msg: "success", data: { workflow_list: [], total: 0 } };
    const failedEnvelope = { code: 400, msg: "'submit_commit_id' field is a 'required' parameter" };
    // thrift 必填缺失的实测形态是 HTTP **400** + `code=400`（快照 §2 第 8 行 / A5），不是 200 + 业务码；
    // 状态与信封必须一起给，否则测到的是自己造的形状，「原样回传上游状态」这条断言就落空了。
    const app = setup((recorded) =>
      recorded.path.endsWith("/save") ? jsonResponse(failedEnvelope, 400) : jsonResponse(okEnvelope),
    );
    const ticket = mintTicket(ORG_A, WF_A);

    const response = await call(app, upstreamPath("workflow_list"), {
      ticket,
      body: {
        workflow_id: WF_A,
        space_id: "forged-space",
        project_id: "forged-project",
        bot_id: "forged-bot",
        page: 1,
        size: 20,
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(okEnvelope);
    const forwarded = onlyApiCall();
    expect(forwarded.path).toBe("/api/workflow_api/workflow_list");
    expect(forwarded.body).toEqual({
      workflow_id: WF_A,
      page: 1,
      size: 20,
      space_id: SPACE_ID,
      project_id: APP_ID,
    });
    // 出站会话由 1B 的 callUpstream 注入（BFF 不自己拿 cookie）；这里只断言它确实带上了平台会话。
    expect(forwarded.cookie).toBe(`session_key=${COOKIE_VALUE}`);

    // GET 面的 space_id 绑在查询串上（IDL 必填）：剥离伪造值后必须补上，否则缺参会把正常轮询打成上游报错。
    const getResponse = await call(
      app,
      `${upstreamPath("get_process")}?workflow_id=${WF_A}&space_id=forged-space&execute_id=exec-1`,
      { ticket, method: "GET" },
    );
    expect(getResponse.status).toBe(200);
    const getForwarded = apiCalls()[1];
    expect(getForwarded.method).toBe("GET");
    expect(getForwarded.body).toBeNull();
    const [pathname, search] = getForwarded.path.split("?");
    expect(pathname).toBe("/api/workflow_api/get_process");
    expect(Object.fromEntries(new URLSearchParams(search))).toEqual({
      workflow_id: WF_A,
      execute_id: "exec-1",
      space_id: SPACE_ID,
    });

    const failed = await call(app, upstreamPath("save"), { ticket, body: { workflow_id: WF_A } });
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual(failedEnvelope);
  });

  // 上游 panic 的 msg 带 Go 堆栈、绝对路径与内部函数名（JSON 与纯文本两种形态，快照 §2.1 F5），必须换成固定
  // 文案后再回传，原始 msg 只进服务端日志（冻结 §6）——这是本面唯一一处「故意改写上游响应」。
  test("上游 panic（JSON 与纯文本两种形态）→ msg 脱敏、堆栈不外泄", async () => {
    const stack =
      'panic error: strconv.ParseInt: parsing "": invalid syntax\ngoroutine 1 [running]:\nmain.serveWorkflow(0x1400012)\n\t/home/upstream/backend/api/workflow/service.go:412';
    const app = setup((recorded) =>
      recorded.path.endsWith("history_schema")
        ? jsonResponse({ code: PANIC_CODE, msg: stack })
        : new Response(`code=${PANIC_CODE} message=panic error\n\t/home/upstream/backend/x.go:9`, { status: 500 }),
    );
    const ticket = mintTicket(ORG_A, WF_A);

    const json = await call(app, upstreamPath("history_schema"), { ticket, body: { workflow_id: WF_A } });
    expect(json.status).toBe(200);
    const jsonText = await json.text();
    expect(JSON.parse(jsonText)).toEqual({ code: PANIC_CODE, msg: "upstream rejected the request" });
    for (const leaked of ["goroutine", "/home/upstream", "service.go", "strconv.ParseInt"])
      expect(jsonText).not.toContain(leaked);

    const text = await call(app, upstreamPath("node_type"), { ticket, body: { workflow_id: WF_A } });
    expect(text.status).toBe(500);
    const textBody = await text.text();
    expect(JSON.parse(textBody)).toEqual({ code: PANIC_CODE, msg: "upstream rejected the request" });
    expect(textBody).not.toContain("/home/upstream");
  });

  // 三个节点端点必须按 fail-closed 许可集裁剪：客户端不可信，服务端把完整节点面板交出去就等于放开了被排除
  // 的插件 / 数据集 / 循环家族（冻结 §5）。裁剪只动节点列表字段，信封其余部分保持原样。
  test("节点端点按许可集过滤（fail-closed）", async () => {
    const fixtures: Record<string, unknown> = {
      "/api/workflow_api/node_type": {
        code: 0,
        msg: "success",
        data: {
          node_types: ["1", "4", "45"],
          sub_workflow_node_types: ["9", "3"],
          nodes_properties: [
            { type: "4", name: "Plugin" },
            { type: "3", name: "LLM" },
          ],
        },
      },
      "/api/workflow_api/node_template_list": {
        code: 0,
        msg: "success",
        data: {
          template_list: [
            { node_type: "57", name: "JsonParser" },
            { node_type: "3", name: "LLM" },
            { type: 5, name: "Code" },
          ],
          cate_list: [{ node_type_list: ["1", "4"] }],
          plugin_api_list: [{ node_type: "4", name: "Plugin" }],
        },
      },
      "/api/workflow_api/node_panel_search": {
        code: 0,
        msg: "success",
        data: {
          resource_workflow: { workflow_list: [{ id: "w1" }], has_more: true },
          favorite_plugin: { plugin_list: [{ id: "p1" }], has_more: true },
          resource_knowledge: { knowledge_list: [{ id: "k1" }], has_more: true },
        },
      },
    };
    const app = setup((recorded) => jsonResponse(fixtures[recorded.path] ?? { code: 0, msg: "success", data: null }));
    const ticket = mintTicket(ORG_A, WF_A);
    const read = async (endpoint: string) =>
      (await call(app, upstreamPath(endpoint), { ticket, body: { workflow_id: WF_A } })).json();

    // 许可集外（4 插件、9 子工作流、57 JsonParser）逐项滤除；数字形态的 type 走同一条判定。
    expect(await read("node_type")).toEqual({
      code: 0,
      msg: "success",
      data: { node_types: ["1", "45"], sub_workflow_node_types: ["3"], nodes_properties: [{ type: "3", name: "LLM" }] },
    });
    expect(await read("node_template_list")).toEqual({
      code: 0,
      msg: "success",
      data: {
        template_list: [
          { node_type: "3", name: "LLM" },
          { type: 5, name: "Code" },
        ],
        cate_list: [{ node_type_list: ["1"] }],
        plugin_api_list: [],
      },
    });
    // 面板搜索按组键映射家族：被排除的家族整组清空并把 has_more 撤为 false；映射表以外的组原样保留。
    expect(await read("node_panel_search")).toEqual({
      code: 0,
      msg: "success",
      data: {
        resource_workflow: { workflow_list: [], has_more: false },
        favorite_plugin: { plugin_list: [], has_more: false },
        resource_knowledge: { knowledge_list: [{ id: "k1" }], has_more: true },
      },
    });
    expect(apiCalls()).toHaveLength(3);
  });

  // 时间戳原样透传、不做单位换算：`workflow_list` 的 create_time/update_time 是秒，`list_spans` 的
  // start_at/end_at 是毫秒，任何「统一成毫秒 / 秒」的改写都会静默改变画布的展示口径（冻结 §6，快照 F7）。
  // 同时覆盖 `list_spans` 的裸形状（无 code/msg/data 包装）——包装会打断画布 SDK 的解析（快照 F6）。
  test("时间戳原样透传（秒与毫秒都不换算、裸形状不包装）", async () => {
    const listEnvelope = {
      code: 0,
      msg: "success",
      data: { workflow_list: [{ workflow_id: WF_A, create_time: 1790678418, update_time: 1790678418 }], total: 1 },
    };
    const spansPayload = { spans: [{ start_at: 1790678418000, end_at: 1790678420000 }] };
    const app = setup((recorded) => jsonResponse(recorded.path.endsWith("list_spans") ? spansPayload : listEnvelope));
    const ticket = mintTicket(ORG_A, WF_A);

    const listed = await call(app, upstreamPath("workflow_list"), { ticket, body: { workflow_id: WF_A } });
    expect(await listed.json()).toEqual(listEnvelope);
    const spans = await call(app, upstreamPath("list_spans"), { ticket, body: { workflow_id: WF_A } });
    expect(await spans.json()).toEqual(spansPayload);
  });

  // 存储直链的 host 是对象存储而非上游自身，浏览器经 `/workflow-canvas/*` 到不了，必须换成同源反代前缀
  // （冻结 §6.1）。替换只认「已知存储桶路径 + origin 不是上游」，其它 URL 一个字节都不动，避免误伤。
  test("图片端点：已知存储直链改写为同源反代前缀", async () => {
    const signed = `${STORAGE_ORIGIN}/opencoze/workflow/icon.png?X-Amz-Signature=fixture`;
    const proxied = "/workflow-canvas/storage/opencoze/workflow/icon.png?X-Amz-Signature=fixture";
    const external = "https://cdn.example.invalid/other.png";
    const app = setup((recorded) =>
      recorded.path.endsWith("get_imagex_url")
        ? jsonResponse({
            code: 0,
            msg: "success",
            data: { url_info: { "uri-1": { url: signed }, "uri-2": { url: external } } },
          })
        : jsonResponse({ code: 0, msg: "success", url: signed }),
    );
    const ticket = mintTicket(ORG_A, WF_A);

    // `sign_image_url` 的 url 在**顶层**（快照 §2 第 28 行）：按 data.url 取值会改写不到。
    const signedResponse = await call(app, upstreamPath("sign_image_url"), { ticket, body: { workflow_id: WF_A } });
    expect(await signedResponse.json()).toEqual({ code: 0, msg: "success", url: proxied });
    const imagexResponse = await call(app, `${BFF_PREFIX}/api/playground_api/get_imagex_url`, {
      ticket,
      body: { workflow_id: WF_A },
    });
    expect(await imagexResponse.json()).toEqual({
      code: 0,
      msg: "success",
      data: { url_info: { "uri-1": { url: proxied }, "uri-2": { url: external } } },
    });
  });
});

describe("canvas-bff 请求体约束与失败映射", () => {
  // 请求体必须有上界：JSON 面 8 MiB、上传面 32 MiB（显式放大但仍有界），超出即 413 且不触上游——不设上界等于
  // 让一个请求把进程的内存吃光。非 JSON 体（裸字节上传腿）显式 501：`callUpstream` 只发 JSON，把字节 JSON 化会
  // 静默损坏内容，比明说「不支持」糟得多（已知缺口，解除条件是 `callUpstream` 支持原样透传请求体）。
  test("上传路径放行；超限 413、非 JSON 体 501，都不触上游", async () => {
    const app = setup(() => envelope({}));
    const ticket = mintTicket(ORG_A, WF_A);
    const uploadPath = `${BFF_PREFIX}/api/common/upload/apply_upload_action`;

    expect((await call(app, uploadPath, { ticket, body: { workflow_id: WF_A } })).status).toBe(200);
    expect(apiCalls().at(-1)?.path).toBe("/api/common/upload/apply_upload_action");

    const tooLarge = async (path: string, limit: number) =>
      expectFailure(
        await call(app, path, {
          ticket,
          body: { workflow_id: WF_A },
          headers: { "content-length": String(limit + 1) },
        }),
        413,
        "payload_too_large",
      );
    await tooLarge(uploadPath, 32 * 1024 * 1024);
    await tooLarge(upstreamPath("save"), 8 * 1024 * 1024);
    await expectFailure(await call(app, uploadPath, { ticket, body: [1, 2, 3] }), 501, "unsupported_body");
    // 只有第一条（合法上传）到过上游。
    expect(apiCalls()).toHaveLength(1);
  });

  // 上游异常必须按语义映射且都不透传上游文案：超时 504、平台账号不可用 503（画布据此重试或降级，而不是把
  // 未鉴权的请求发出去、或让浏览器挂在永不返回的透传上）；会话失效（HTTP 200 + 700012006，设计 §9.1.1 第
  // 1 条）由 1B 的 callUpstream 统一处理——作废 → 重登 → 重放一次，BFF 只消费结果、不碰 cookie。
  test("上游异常映射：超时 504、会话不可用 503、会话失效重登重放", async () => {
    const slow = setup(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return envelope({});
      },
      { upstreamTimeoutMs: 80 },
    );
    await expectFailure(
      await call(slow, upstreamPath("canvas"), { ticket: mintTicket(ORG_A, WF_A), body: { workflow_id: WF_A } }),
      504,
      "upstream_timeout",
    );

    const noSession = setup(() => envelope({}), {
      login: () => jsonResponse({ code: 700000003, msg: "login rejected" }),
    });
    await expectFailure(
      await call(noSession, upstreamPath("canvas"), { ticket: mintTicket(ORG_A, WF_A), body: { workflow_id: WF_A } }),
      503,
      "upstream_session_unavailable",
    );

    let apiAttempts = 0;
    const expired = setup(() => {
      apiAttempts += 1;
      return apiAttempts === 1
        ? jsonResponse({ code: AUTH_FAILED_CODE, msg: "authentication failed: session not exist" })
        : envelope({ ok: true });
    });
    const replayed = await call(expired, upstreamPath("canvas"), {
      ticket: mintTicket(ORG_A, WF_A),
      body: { workflow_id: WF_A },
    });
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toEqual({ code: 0, msg: "success", data: { ok: true } });
    // 初始登录 + 失效后的重登（共两条登录腿）；业务请求发两次（首次被判定失效 + 重放一次）。
    expect(requests.filter((request) => request.path.startsWith("/api/passport/"))).toHaveLength(2);
    expect(apiCalls()).toHaveLength(2);
  });
});

describe("canvas-bff 调试运行轮询预算", () => {
  // 画布一次调试运行会以 300ms 无上限递归轮询 get_process（`LOOP_GAP_TIME`）：同一 execute_id 在窗口内的
  // 重复轮询必须复用同一次上游响应——一次 60 秒的运行否则就是两百次上游请求。回放还要逐字段等价，画布才
  // 感知不到（它把任何非成功响应当作运行失败）。
  test("同一 execute_id 在窗口内只打一次上游，两次响应逐字段等价", async () => {
    const payload = { code: 0, msg: "success", data: { executeStatus: 1, nodeResults: { "node-1": { status: 2 } } } };
    const app = setup(() => jsonResponse(payload));
    const ticket = mintTicket(ORG_A, WF_A);
    const url = `${upstreamPath("get_process")}?workflow_id=${WF_A}&execute_id=exec-budget-hit`;

    const first = await call(app, url, { ticket, method: "GET" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(payload);
    const second = await call(app, url, { ticket, method: "GET" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(payload);
    expect(apiCalls()).toHaveLength(1);
  });

  // 画布侧同一 execute_id 有多个轮询者（运行循环、结果面板、节点历史），相位错开时会同时到达：在飞行的
  // 同键请求必须合并成一次上游调用，否则「省请求」在并发下完全不成立。
  test("同键并发请求合并为一次上游调用", async () => {
    const app = setup(async () => {
      // 拉长上游耗时，让两个请求真的重叠在一起（否则第二个会走窗口回放，测不到在飞行合并）。
      await new Promise((resolve) => setTimeout(resolve, 40));
      return envelope({ executeStatus: 1 });
    });
    const ticket = mintTicket(ORG_A, WF_A);
    const url = `${upstreamPath("get_process")}?workflow_id=${WF_A}&execute_id=exec-budget-concurrent`;

    const [a, b] = await Promise.all([
      call(app, url, { ticket, method: "GET" }),
      call(app, url, { ticket, method: "GET" }),
    ]);
    expect(await a.json()).toEqual({ code: 0, msg: "success", data: { executeStatus: 1 } });
    expect(await b.json()).toEqual({ code: 0, msg: "success", data: { executeStatus: 1 } });
    expect(apiCalls()).toHaveLength(1);
  });

  // 回放只限窗口，窗口外必须重新问上游：永久缓存 = 画布永远停在旧状态，比多打一次上游糟得多。
  test("窗口外的下一次轮询重新打上游", async () => {
    let attempt = 0;
    const app = setup(() => {
      attempt += 1;
      return envelope({ executeStatus: attempt });
    });
    const ticket = mintTicket(ORG_A, WF_A);
    const url = `${upstreamPath("get_process")}?workflow_id=${WF_A}&execute_id=exec-budget-expire`;
    const readStatus = async (): Promise<unknown> =>
      ((await (await call(app, url, { ticket, method: "GET" })).json()) as { data: unknown }).data;

    expect(await readStatus()).toEqual({ executeStatus: 1 });
    await new Promise((resolve) => setTimeout(resolve, GET_PROCESS_CACHE_TTL_MS + 60));
    expect(await readStatus()).toEqual({ executeStatus: 2 });
    expect(apiCalls()).toHaveLength(2);
  });

  // 失败不是可缓存的事实：瞬时错误若进了缓存，画布会在整个窗口里稳定看到失败并终止这次调试运行。
  test("上游失败不写缓存，下一次轮询仍打上游", async () => {
    let attempt = 0;
    const failedEnvelope = { code: 400, msg: "execute not found" };
    const app = setup(() => {
      attempt += 1;
      return attempt === 1 ? jsonResponse(failedEnvelope, 400) : envelope({ executeStatus: 2 });
    });
    const ticket = mintTicket(ORG_A, WF_A);
    const url = `${upstreamPath("get_process")}?workflow_id=${WF_A}&execute_id=exec-budget-fail`;

    const failed = await call(app, url, { ticket, method: "GET" });
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual(failedEnvelope);
    // 同键的下一次轮询必须重新落到上游，并拿到此刻的真实状态。
    const recovered = await call(app, url, { ticket, method: "GET" });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ code: 0, msg: "success", data: { executeStatus: 2 } });
    expect(apiCalls()).toHaveLength(2);
  });

  // 缓存键必须含组织与 execute_id：跨组织共享条目就是跨租户泄漏运行状态（平台第一安全约束），同组织不同
  // 运行之间同样不能串。这里刻意让两个组织的请求用同一个 execute_id，命中失败才说明键真的是复合的。
  test("不同组织与不同 execute_id 之间不共享条目", async () => {
    const app = setup(() => envelope({ ok: true }), {
      workflows: [workflowRow(ORG_A, WF_A), workflowRow(ORG_B, WF_B)],
      app: [
        { organizationId: ORG_A, appId: APP_ID, status: "active" },
        { organizationId: ORG_B, appId: "app-fixture-2", status: "active" },
      ],
    });
    const urlOf = (workflowId: string, executeId: string) =>
      `${upstreamPath("get_process")}?workflow_id=${workflowId}&execute_id=${executeId}`;

    await call(app, urlOf(WF_A, "exec-budget-shared"), { ticket: mintTicket(ORG_A, WF_A), method: "GET" });
    await call(app, urlOf(WF_B, "exec-budget-shared"), { ticket: mintTicket(ORG_B, WF_B), method: "GET" });
    expect(apiCalls()).toHaveLength(2);
    // 同组织、另一个 execute_id 也各算各的。
    await call(app, urlOf(WF_A, "exec-budget-other"), { ticket: mintTicket(ORG_A, WF_A), method: "GET" });
    expect(apiCalls()).toHaveLength(3);
  });

  // 只有 get_process 参与预算：写接口（save/create）缓存是错误的，其它读接口也没有「300ms 无上限轮询」这个
  // 前提；缺 execute_id 的形态（上游只挂 GET，缺参是上游的错）同样不参与，保持原始透传。
  test("非 get_process 路径与缺 execute_id 的请求都不受影响", async () => {
    const app = setup(() => envelope({ ok: true }));
    const ticket = mintTicket(ORG_A, WF_A);
    await call(app, upstreamPath("canvas"), { ticket, body: { workflow_id: WF_A } });
    await call(app, upstreamPath("canvas"), { ticket, body: { workflow_id: WF_A } });
    await call(app, upstreamPath("workflow_list"), { ticket, body: { workflow_id: WF_A } });
    await call(app, `${upstreamPath("get_process")}?workflow_id=${WF_A}`, { ticket, method: "GET" });
    await call(app, `${upstreamPath("get_process")}?workflow_id=${WF_A}`, { ticket, method: "GET" });
    expect(apiCalls()).toHaveLength(5);
  });
});

describe("canvas-bff 会话端点", () => {
  // 兑换是本面唯一免票入口：code 单次消费，重复兑换与未知 code 同形返回 400，不给「code 是否存在」的探测
  // 面；响应是上游信封形状，画布按它取 ticket（冻结 §7）。超出窗口配额即 429，且拒绝发生在兑换之前——
  // 超限请求不消耗 code，也不给探测面（配额与窗口见 `canvas-passthrough` 的限速注释）。
  test("session/exchange：单次消费、缺参 400、超出来源配额 429", async () => {
    const app = setup(() => envelope({}));
    const exchangePath = `${BFF_PREFIX}/session/exchange`;
    const { code } = issueCode({ userId: USER_ID, orgId: ORG_A, workflowId: WF_A });

    const first = await call(app, exchangePath, { body: { code } });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      code: 0,
      msg: "success",
      data: {
        ticket: expect.any(String),
        expiresAt: expect.any(Number),
        claims: { typ: "wf-canvas", sub: USER_ID, org: ORG_A, wf: WF_A },
      },
    });
    await expectFailure(await call(app, exchangePath, { body: { code } }), 400, "invalid_code");
    await expectFailure(await call(app, exchangePath, { body: {} }), 400, "invalid_code");
    // 上两步用掉 3 次配额，补满本来源的窗口（60 次）后必须开始拒绝。
    for (let attempt = 3; attempt < 60; attempt += 1) {
      await expectFailure(await call(app, exchangePath, { body: { code: "unknown-code" } }), 400, "invalid_code");
    }
    await expectFailure(await call(app, exchangePath, { body: { code: "unknown-code" } }), 429, "too_many_attempts");
  });

  // 续期只能缩短会话：新票据的 exp 取「原 exp」与「now + 票据 TTL」的较小者并保持同一 sid，坏票连验签都过
  // 不了；撤销按 sid 整族生效，透传与续期入口一起失效。两个端点都不触上游（冻结 §7）。
  test("session/refresh 与 revoke：续期不延长、撤销后透传与续期都 401", async () => {
    const app = setup(() => envelope({}));
    const original = mintTicket(ORG_A, WF_A);
    const originalClaims = verifyTicket(original);
    if (originalClaims === null) throw new Error("测试票据验签失败");

    const refreshed = await call(app, `${BFF_PREFIX}/session/refresh`, { ticket: original });
    expect(refreshed.status).toBe(200);
    const data = (await refreshed.json()).data as { ticket: string; expiresAt: number };
    const refreshedClaims = verifyTicket(data.ticket);
    if (refreshedClaims === null) throw new Error("续期返回的票据验签失败");
    expect(refreshedClaims.sid).toBe(originalClaims.sid);
    expect(data.ticket).not.toBe(original);
    expect(refreshedClaims.exp).toBeLessThanOrEqual(Math.min(originalClaims.exp, Math.floor(Date.now() / 1000) + 900));
    expect(data.expiresAt).toBe(refreshedClaims.exp);
    await expectFailure(
      await call(app, `${BFF_PREFIX}/session/refresh`, { ticket: "not-a-ticket" }),
      401,
      "ticket_invalid",
    );

    const revoked = await call(app, `${BFF_PREFIX}/session/revoke`, { ticket: original });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ code: 0, msg: "success", data: { revoked: true } });
    await expectFailure(
      await call(app, upstreamPath("canvas"), { ticket: original, body: { workflow_id: WF_A } }),
      401,
      "ticket_invalid",
    );
    await expectFailure(await call(app, `${BFF_PREFIX}/session/refresh`, { ticket: original }), 401, "ticket_invalid");
    expect(requests).toHaveLength(0);
  });
});

describe("canvas-bff 限流（4B）", () => {
  // 画布面按票据 `sub` 的令牌桶计数：打满后必须是**真实 HTTP 429 + Retry-After**，且**不能**是 401——画布只在
  // 401 时换票，把限流做成 401 会让它去换一张同样被限的票（冻结 §7）。被限的请求不得触上游。
  test("透传面按用户令牌桶限流并返回 429 + Retry-After", async () => {
    const app = setup(() => envelope({ workflow_id: WF_A }), { bffRateLimitPerMinute: 3 });
    const ticket = mintTicket(ORG_A, WF_A);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const allowed = await call(app, upstreamPath("canvas"), { ticket, body: { workflow_id: WF_A } });
      expect(allowed.status).toBe(200);
    }
    const limited = await call(app, upstreamPath("canvas"), { ticket, body: { workflow_id: WF_A } });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ code: 429, msg: "too_many_attempts" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // 配额内的三次真的到了上游，被限的那次没有。
    expect(apiCalls()).toHaveLength(3);
  });

  // 桶按 `sub` 隔离：一个用户打满不得影响另一个用户——反代之后所有来源共享同一个入口地址，按来源计数会把
  // 「一个用户在刷」放大成「所有人被拒」。
  test("不同用户的画布配额互相隔离", async () => {
    const app = setup(() => envelope({}), { bffRateLimitPerMinute: 2 });
    const heavyUser = mintTicket(ORG_A, WF_A, "user-fixture-bff-heavy");
    const otherUser = mintTicket(ORG_A, WF_A, "user-fixture-bff-light");

    await call(app, upstreamPath("canvas"), { ticket: heavyUser, body: { workflow_id: WF_A } });
    await call(app, upstreamPath("canvas"), { ticket: heavyUser, body: { workflow_id: WF_A } });
    await expectFailure(
      await call(app, upstreamPath("canvas"), { ticket: heavyUser, body: { workflow_id: WF_A } }),
      429,
      "too_many_attempts",
    );
    expect((await call(app, upstreamPath("canvas"), { ticket: otherUser, body: { workflow_id: WF_A } })).status).toBe(
      200,
    );
  });

  // 无效票据走**来源桶**、有效票据走**用户桶**：伪造票据因此打不到任何真实用户的配额，只能刷自己的来源桶。
  test("无效票据计入来源桶而不污染用户桶", async () => {
    const app = setup(() => envelope({}), { sessionRateLimitPerMinute: 2 });
    const ticket = mintTicket(ORG_A, WF_A);
    const refreshPath = `${BFF_PREFIX}/session/refresh`;

    await expectFailure(await call(app, refreshPath, { ticket: "not-a-ticket" }), 401, "ticket_invalid");
    await expectFailure(await call(app, refreshPath, { ticket: "not-a-ticket" }), 401, "ticket_invalid");
    // 来源桶已空：有效票据仍能续期（它用的是同一个用户的桶，此前未被消耗）。
    expect((await call(app, refreshPath, { ticket })).status).toBe(200);
    // 来源桶的下一次请求（兑换同样免票、同源）必须被拒——两次 401 确实记在了来源桶上。
    const exchange = await call(app, `${BFF_PREFIX}/session/exchange`, { body: { code: "unknown-code" } });
    expect(exchange.status).toBe(429);
    expect(Number(exchange.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });
});
