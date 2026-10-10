// 列表页发布状态读路径（`workflow-publish-state.ts` + `GET /web/workflow-v2/workflows`）的行为契约。
//
// 这条读路径是卡片状态列的**唯一事实来源**，本次修复的核心判据是「读不到 ≠ 未发布」，因此重点断言四件事：
// ① 解析：上游有条目且版本非空 → 已发布；条目在且版本为空 → 未发布；**没有条目或整批失败 → 未知**；
// ② 出站形状：一页只发一次上游调用，`space_id` 由服务端注入、`workflow_filter_list` 带上本页全部 id；
// ③ 失败隔离：上游传输/会话/业务失败只降级状态列，列表本身照常 200（不把读不到升级成整页失败）；
// ④ 绑定不可用（未绑定/降级）时不发出站请求，状态一律未知；而**台账缺行**（应用绑定行还在）必须像其它读路径
//    一样按需引导自愈——真机反馈过「卡片状态未知、发布日志却有 v0.0.4」的两个真相，成因就在这里。
//
// 夹具（数据库句柄、守卫与上游替身）在 `helpers/console-plane-harness.ts`；无数据库时整组跳过（显式打印原因）。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { initializeTestApplicationInfrastructure, readJson, resetAllStubs } from "@fenix/platform-sdk/testing";
import { Elysia } from "elysia";
import { createWebWorkflowV2WorkflowRoutes } from "../server/routes/web/workflows";
import { type UpstreamCallResult, UpstreamCircuitOpenError } from "../server/services/upstream-client";
import { resetUpstreamHealth } from "../server/services/upstream-health";
import { getUpstreamSession } from "../server/services/upstream-session";
import { resetUpstreamSessionStoreForTests } from "../server/services/upstream-session-store";
import {
  listWorkflowsWithPublishStatus,
  parseWorkflowPublishStatuses,
  readUpstreamPublishStatuses,
} from "../server/services/workflow-publish-state";
import { createWorkflowV2ModuleConfig } from "../server/testing";
import {
  cleanupTestRows,
  clearPlatformAccount,
  closeTestPool,
  countPlatformAccounts,
  createStubAuthGuard,
  createTestScopedDatabase,
  createUpstreamStub,
  databaseReachable,
  installDatabase,
  ORG_A,
  OWNER_ID,
  readBody,
  request,
  SPACE_ID,
  seedBinding,
  seedRecord,
  sentBody,
  upstreamFail,
  upstreamId,
  upstreamOk,
} from "./helpers/console-plane-harness";

/** 上游「工作流详情」端点：列表与发布前的版本读取走它（选型理由见服务文件头）。 */
const DETAIL_INFO_PATH = "/api/workflow_api/workflow_detail_info";

type Responses = Record<string, () => UpstreamCallResult | Promise<UpstreamCallResult>>;

/**
 * 本文件的列表响应形状。
 *
 * 不用夹具的 `readBody`：它的类型面向运行记录（`items` 是同名字段但另一套列），本文件要断言的是列表项上的
 * 发布态。夹具文件由另一个任务持有，这里只读不改。
 */
interface ListBody {
  readonly success: boolean;
  readonly data?: {
    readonly items?: Array<{
      readonly id: string;
      readonly upstreamWorkflowId: string;
      readonly publishState: string;
      readonly publishedVersion: string | null;
    }>;
    readonly total?: number;
  };
  readonly error?: { readonly code: string; readonly message: string };
}

const readListBody = async (response: Response) => (await readJson(response)) as ListBody;

/** 上游成功响应：每个 workflow 一条，`latest_flow_version` 为空串即「未发布」。 */
const detailInfoOk = (entries: Array<{ id: string; version: string | null }>) =>
  upstreamOk({ data: entries.map(({ id, version }) => ({ workflow_id: id, latest_flow_version: version ?? "" })) });

describe("上游响应的状态解析（纯函数）", () => {
  // 上游对未发布回空串、对不认识的 id 直接省略条目：两者必须得到不同结论，否则「没读到」会被说成「未发布」。
  test("有条目按版本判定，没有条目判为未知", () => {
    const statuses = parseWorkflowPublishStatuses(
      {
        data: [
          { workflow_id: "a", latest_flow_version: "v0.0.3" },
          { workflow_id: "b", latest_flow_version: "" },
        ],
      },
      ["a", "b", "c"],
    );

    expect(statuses.get("a")).toEqual({ publishState: "published", publishedVersion: "v0.0.3" });
    expect(statuses.get("b")).toEqual({ publishState: "unpublished", publishedVersion: null });
    expect(statuses.get("c")).toEqual({ publishState: "unknown", publishedVersion: null });
  });

  // 请求之外的 id 不得进入结果（上游若放宽过滤语义，别的 workflow 的版本也不能挂到本页条目上）。
  test("忽略请求之外的条目", () => {
    const statuses = parseWorkflowPublishStatuses({ data: [{ workflow_id: "other", latest_flow_version: "v9.9.9" }] }, [
      "a",
    ]);

    expect(statuses.size).toBe(1);
    expect(statuses.get("a")?.publishState).toBe("unknown");
  });

  // 响应形状坏掉（缺 data、data 不是数组）时一律未知：解析不出事实就不给结论。
  test("响应形状异常时全部未知", () => {
    for (const body of [{}, { data: null }, { data: {} }, "boom"]) {
      expect(parseWorkflowPublishStatuses(body, ["a", "b"]).get("a")?.publishState).toBe("unknown");
    }
  });
});

describe("上游读取的出站形状与失败分类（注入端口）", () => {
  test("一次调用覆盖全部 id，并注入服务端 space_id", async () => {
    const upstream = createUpstreamStub({
      [DETAIL_INFO_PATH]: () => detailInfoOk([{ id: "a", version: "v0.0.1" }]),
    });

    const read = await readUpstreamPublishStatuses(
      { spaceId: SPACE_ID, upstreamWorkflowIds: ["a", "b"] },
      { callUpstream: upstream.call },
    );

    expect(read.failure).toBeNull();
    expect(read.statuses.get("a")).toEqual({ publishState: "published", publishedVersion: "v0.0.1" });
    expect(read.statuses.get("b")?.publishState).toBe("unknown");
    expect(sentBody(upstream.calls, 0).space_id).toBe(SPACE_ID);
    expect(sentBody(upstream.calls, 0).workflow_filter_list).toEqual([{ workflow_id: "a" }, { workflow_id: "b" }]);
  });

  // 空集不发请求：一次空翻页不该付出站代价（也不该触发登录/探活这类副作用）。
  test("没有 id 时不发请求", async () => {
    const upstream = createUpstreamStub({});

    const read = await readUpstreamPublishStatuses(
      { spaceId: SPACE_ID, upstreamWorkflowIds: [] },
      { callUpstream: upstream.call },
    );

    expect(read.statuses.size).toBe(0);
    expect(read.failure).toBeNull();
    expect(upstream.calls).toHaveLength(0);
  });

  // 上游业务拒绝与传输失败都必须**如实带回**（调用方据此决定拒绝发布还是降级），而不是被吞成「未发布」。
  test("上游业务拒绝与传输失败都带回失败原因且状态全未知", async () => {
    const rejected = createUpstreamStub({ [DETAIL_INFO_PATH]: () => upstreamFail(777777775, "panic") });
    const rejectedRead = await readUpstreamPublishStatuses(
      { spaceId: SPACE_ID, upstreamWorkflowIds: ["a"] },
      { callUpstream: rejected.call },
    );
    expect(rejectedRead.failure?.kind).toBe("upstream");
    expect(rejectedRead.statuses.get("a")?.publishState).toBe("unknown");

    const thrown = createUpstreamStub({
      [DETAIL_INFO_PATH]: () => {
        throw new UpstreamCircuitOpenError(DETAIL_INFO_PATH, 1000);
      },
    });
    const thrownRead = await readUpstreamPublishStatuses(
      { spaceId: SPACE_ID, upstreamWorkflowIds: ["a"] },
      { callUpstream: thrown.call },
    );
    expect(thrownRead.failure?.kind).toBe("transport");
    expect(thrownRead.statuses.get("a")?.publishState).toBe("unknown");
  });
});

describe.skipIf(!databaseReachable)("列表状态投影（真实 Postgres + 上游替身）", () => {
  const guard = createStubAuthGuard();
  let responses: Responses;
  let upstream: ReturnType<typeof createUpstreamStub>;
  let app: Elysia;

  beforeEach(async () => {
    installDatabase();
    await seedBinding();
    responses = {};
    upstream = createUpstreamStub(responses);
    app = new Elysia().use(
      createWebWorkflowV2WorkflowRoutes({ authGuardPlugin: guard.plugin }, { callUpstream: upstream.call }),
    );
    guard.setActor({ organizationId: ORG_A, userId: OWNER_ID });
  });

  afterAll(() => {
    guard.setActor(null);
  });

  // 本次报障的主路径：本地台账说「没发布过」，上游说「已发布 v0.0.1」——列表必须显示上游的版本。
  test("列表状态取自上游而不是本地台账", async () => {
    const published = await seedRecord("status-published");
    const draft = await seedRecord("status-draft");
    responses[DETAIL_INFO_PATH] = () =>
      detailInfoOk([
        { id: published.upstreamWorkflowId, version: "v0.0.1" },
        { id: draft.upstreamWorkflowId, version: null },
      ]);

    const body = await readListBody(await request(app, "/workflows?page=1&size=50"));
    const byId = new Map((body.data?.items ?? []).map((item) => [item.upstreamWorkflowId, item]));

    expect(byId.get(published.upstreamWorkflowId)?.publishState).toBe("published");
    expect(byId.get(published.upstreamWorkflowId)?.publishedVersion).toBe("v0.0.1");
    expect(byId.get(draft.upstreamWorkflowId)?.publishState).toBe("unpublished");
    expect(upstream.calls.filter((call) => call.path === DETAIL_INFO_PATH)).toHaveLength(1);
  });

  // 读不到上游时列表照常 200，状态为 unknown：把整页拖成失败会让「状态没读到」升级成「列表打不开」，
  // 而把 unknown 渲染成「未发布」正是本次报障的方向。
  test("上游读取失败时列表仍 200 且状态为未知", async () => {
    const record = await seedRecord("status-failed");
    responses[DETAIL_INFO_PATH] = () => upstreamFail(777777775, "panic error");

    const response = await request(app, "/workflows?page=1&size=50");
    const body = await readListBody(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    const item = (body.data?.items ?? []).find((entry) => entry.upstreamWorkflowId === record.upstreamWorkflowId);
    expect(item?.publishState).toBe("unknown");
    expect(item?.publishedVersion).toBeNull();
  });

  // 作用域里没有可用空间（路由判定绑定不可用）时不发出站：那种状态下列表页渲染的是引导屏，状态列不会上屏；
  // 服务只把状态降级成未知并留原因标签。
  test("作用域没有可用空间时不触上游且状态为未知", async () => {
    const record = await seedRecord("status-scope-missing");

    const page = await listWorkflowsWithPublishStatus(
      ORG_A,
      { page: 1, size: 50 },
      { platformSpaceId: null, unavailableReason: "not_bound" },
      { callUpstream: upstream.call },
    );

    expect(page.items.find((item) => item.id === record.id)?.publishState).toBe("unknown");
    expect(upstream.calls).toHaveLength(0);
  });

  // 未认证仍是最外层闸门：401 且不触上游（状态读路径不得放宽任何鉴权前置）。
  test("未认证时列表接口返回 401", async () => {
    guard.setActor(null);
    const response = await request(app, "/workflows");
    guard.setActor({ organizationId: ORG_A, userId: OWNER_ID });

    expect(response.status).toBe(401);
    expect((await readBody(response)).error?.code).toBe("UNAUTHENTICATED");
    expect(upstream.calls).toHaveLength(0);
  });
});

// ── 列表读路径与其它读路径的**绑定口径一致性**（假上游：走真实会话与引导链路）──
//
// 为什么必须用假上游而不是注入替身：按需引导（注册 / 登录 / 空间列表）走的是模块级 `callUpstream` 与真实
// 会话，注入替身只覆盖路由层的业务调用，测不到「台账补回」这条关键路径（同 `workflow-binding-recovery.test.ts`）。
// 本组用例钉的是 2026-10-09 真机反馈的那个不一致：台账缺行时列表「状态未知」，而同一屏的发布日志却能读到
// 「当前版本 v0.0.4」——列表必须与其它读路径一样自愈，否则同一页出现两个真相。

const REGISTER_PATH = "/api/passport/web/email/register/v2/";
const LOGIN_PATH = "/api/passport/web/email/login/";
const ACCOUNT_INFO_PATH = "/api/passport/account/info/v2/";
const SPACE_LIST_PATH = "/api/playground_api/space/list";

/** 假上游登录响应回显的上游用户 ID：必须带用例前缀，否则恢复出来的台账行会躲过前缀清理、污染同库其它用例。 */
const PLATFORM_USER_ID = upstreamId("status-account");

let fakeUpstream: ReturnType<typeof Bun.serve> | null = null;
/** 假上游收到的请求路径（当前用例的）。 */
const upstreamRequests: string[] = [];
let upstreamHandler: (path: string) => Response = () => new Response("用例未设置假上游处理器", { status: 500 });

function fakeUpstreamBaseUrl(): string {
  if (fakeUpstream === null) throw new Error("假上游尚未启动");
  return `http://127.0.0.1:${fakeUpstream.port}`;
}

function envelope(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** 登录成功响应；`Set-Cookie` 的 domain 带端口（上游实测形态，cookie jar 一律拒收，须手工解析）。 */
function loginOk(): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data: { user_id_str: PLATFORM_USER_ID } }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie":
        "session_key=session-key-status-fixture; max-age=2592000; domain=127.0.0.1:18080; path=/; HttpOnly; SameSite",
    },
  });
}

/**
 * 装上假上游与指向它的模块配置，并把会话/熔断复位到已知状态。
 *
 * 三个复位缺一不可（与 `workflow-binding-recovery.test.ts` 同因）：熔断与登录租约是**进程级单例**，留着
 * 其它用例驱动的打开态/会话，本用例的第一次调用会被短路或跳过「注册 → 登录」这条链路。
 */
function setupFakeUpstream(handler: (path: string) => Response): void {
  upstreamHandler = handler;
  upstreamRequests.length = 0;
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    database: createTestScopedDatabase(),
    moduleConfigs: {
      "workflow-v2": createWorkflowV2ModuleConfig({
        upstreamBaseUrl: fakeUpstreamBaseUrl(),
        accountEmail: "workflow-v2-status@example.invalid",
        accountPassword: "fixture-password-status-not-a-secret",
      }),
    },
  });
  resetUpstreamHealth();
  resetUpstreamSessionStoreForTests();
  getUpstreamSession().invalidate();
}

describe.skipIf(!databaseReachable)("列表读路径的按需引导自愈（真实 Postgres + 假上游）", () => {
  const guard = createStubAuthGuard();

  beforeAll(() => {
    fakeUpstream = Bun.serve({
      port: 0,
      async fetch(request_) {
        const url = new URL(request_.url);
        upstreamRequests.push(url.pathname);
        await request_.text();
        return upstreamHandler(url.pathname);
      },
    });
  });

  afterAll(() => {
    fakeUpstream?.stop(true);
    fakeUpstream = null;
  });

  beforeEach(async () => {
    installDatabase(createTestScopedDatabase());
    await seedBinding();
    // 复现报告场景：绑定行在（列表页照常显示卡片），平台账号台账缺行。
    await clearPlatformAccount();
    guard.setActor({ organizationId: ORG_A, userId: OWNER_ID });
  });

  afterEach(() => {
    resetAllStubs();
    getUpstreamSession().invalidate();
    upstreamHandler = () => new Response("用例未设置假上游处理器", { status: 500 });
  });

  // 报告场景的回归：台账缺行时列表也要按需引导自愈并拿到上游状态——否则同一屏会出现
  // 「卡片状态未知 / 发布日志当前版本 v0.0.4」两个真相。
  test("台账缺行时列表经按需引导自愈并返回上游发布状态", async () => {
    const record = await seedRecord("status-self-heal");
    setupFakeUpstream((path) => {
      if (path === REGISTER_PATH) return envelope({ code: 700000001, msg: "email already exist" });
      if (path === LOGIN_PATH) return loginOk();
      if (path === ACCOUNT_INFO_PATH) return envelope({ code: 0, data: { locale: "zh-CN" } });
      if (path === SPACE_LIST_PATH)
        return envelope({ code: 0, data: { bot_space_list: [{ id: SPACE_ID, space_type: 1 }] } });
      if (path === DETAIL_INFO_PATH)
        return envelope({ code: 0, data: [{ workflow_id: record.upstreamWorkflowId, latest_flow_version: "v0.0.4" }] });
      return new Response(`用例未覆盖的上游路径：${path}`, { status: 500 });
    });
    const app = new Elysia().use(createWebWorkflowV2WorkflowRoutes({ authGuardPlugin: guard.plugin }));

    const response = await request(app, "/workflows?page=1&size=50");
    const body = await readListBody(response);
    const item = (body.data?.items ?? []).find((entry) => entry.upstreamWorkflowId === record.upstreamWorkflowId);

    expect(response.status).toBe(200);
    expect(item?.publishState).toBe("published");
    expect(item?.publishedVersion).toBe("v0.0.4");
    expect(upstreamRequests).toContain(DETAIL_INFO_PATH);
    // 台账被按需引导补回：下一次页面加载不再需要这次登录，也不必再降级成未知。
    expect(await countPlatformAccounts()).toBe(1);
  });

  // 反向判据：**真正的未绑定**（没有绑定行）不得触发任何出站，也不得把列表打成失败——页面有自己的引导屏。
  test("未绑定组织不触上游且列表仍 200（状态未知）", async () => {
    const unboundOrg = `${ORG_A}-status-unbound`;
    const record = await seedRecord("status-unbound", null, unboundOrg);
    setupFakeUpstream(() => new Response("未绑定组织不该有出站", { status: 500 }));
    const app = new Elysia().use(createWebWorkflowV2WorkflowRoutes({ authGuardPlugin: guard.plugin }));
    guard.setActor({ organizationId: unboundOrg, userId: OWNER_ID });

    const response = await request(app, "/workflows?page=1&size=50");
    const body = await readListBody(response);

    expect(response.status).toBe(200);
    const item = (body.data?.items ?? []).find((entry) => entry.id === record.id);
    expect(item?.publishState).toBe("unknown");
    expect(upstreamRequests).toHaveLength(0);
  });
});

// 收尾与另几份控制面用例同款：先复位守卫再清测试行（只看 `wf2-test-` 前缀），最后关掉本进程的连接池。
afterAll(async () => {
  if (!databaseReachable) return;
  installDatabase();
  await cleanupTestRows();
  await closeTestPool();
});
