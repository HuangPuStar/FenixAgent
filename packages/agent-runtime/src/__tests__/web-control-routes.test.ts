import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWebControlRoutes } from "@fenix/agent-runtime/server";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { resetEnvironmentRepoStub, stubEnvironmentRepo } from "@server/test-utils/stubs/module-stubs";
import { bindSessionEventBusPort, resetSessionEventBusPort } from "../server/services/session-event-bus-port";
import { initializeAgentRuntimeModuleConfig } from "../server/testing";
import { getAllEventBuses, getEventBus, removeEventBus } from "../transport/event-bus";
import { createStubAgentRuntimeAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

// 控制面的资源标识是持久 instanceUid（`inst_` + 32 位十六进制），会话在事件总线里的键与它同值。
const INSTANCE_UID = "inst_0123456789abcdef0123456789abcdef";

const controlRoute = createWebControlRoutes({
  authGuardPlugin: createStubAgentRuntimeAuthGuardPlugin(),
});

function request(path: string, init?: RequestInit) {
  return controlRoute.handle(new Request(`http://localhost${path}`, init));
}

function post(path: string, body: unknown) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * 归属校验读两份数据，替身来源不同、必须分别设置：
 *
 * - 实例归属走真实仓储（`agentInstanceService.getOwnedInstance` → `db.select().from().where().limit()`），
 *   用 `stubDb` 给一行实例记录；
 * - 环境组织归属走 `environmentRepo.getById`，而该模块被宿主 preload 的 `mock.module` 换成
 *   实时转发 Proxy（`apps/server/src/test-utils/setup-mocks.ts`），所以只能经它的登记替身设置。
 */
function stubInstanceOwnership(...results: unknown[][]) {
  const queue = [...results];
  stubDb({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(queue.shift() ?? []),
        }),
      }),
    }),
  } as never);
}

function stubEnvironment(organizationId: string | null) {
  stubEnvironmentRepo({ getById: async () => ({ id: "env-1", userId: "user-1", organizationId }) });
}

function instanceRow() {
  return { id: INSTANCE_UID, environmentId: "env-1", ownerUserId: "user-1" };
}

describe("Web Control Routes", () => {
  beforeEach(() => {
    initializeAgentRuntimeModuleConfig();
    // 会话服务的读写都经这个窄端口（宿主 main.ts 用同一对实现绑定）；
    // 总线注册表是模块级单例，事件由 `publishSessionEvent` 写入、由这里读出断言。
    bindSessionEventBusPort({ getAllBuses: getAllEventBuses, removeBus: removeEventBus });
    setTestAuth({ organizationId: "org-1", userId: "user-1" });
  });

  afterEach(() => {
    removeEventBus(INSTANCE_UID);
    resetSessionEventBusPort();
    resetEnvironmentRepoStub();
    resetTestAuth();
    resetAllStubs();
  });

  // 控制面必须与宿主 `/web/*` 共用同一份认证：未认证请求由守卫拦下。
  test("未认证请求被守卫拒绝", async () => {
    resetTestAuth();

    const response = await post(`/sessions/${INSTANCE_UID}/events`, { content: "hi" });

    expect(response.status).toBe(401);
  });

  // 总线里没有该会话即视为不存在——不区分「从未存在」与「已结束」，避免用返回码探测会话。
  test("会话不在事件总线中时返回 404", async () => {
    const response = await post(`/sessions/${INSTANCE_UID}/events`, { content: "hi" });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found", message: "Session not found" } });
  });

  // 实例归属不匹配（仓储查不到该用户的实例）时保守拒绝，且不回显内部标识。
  test("实例不属于当前用户时返回 403", async () => {
    getEventBus(INSTANCE_UID);
    stubInstanceOwnership([]);

    const response = await post(`/sessions/${INSTANCE_UID}/events`, { content: "hi" });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "forbidden", message: "Session does not belong to your organization" },
    });
  });

  // 实例归属通过后还要回查环境的组织归属：跨组织会话必须被拒绝（多租户隔离）。
  test("环境的组织与请求上下文不一致时返回 403", async () => {
    getEventBus(INSTANCE_UID);
    stubInstanceOwnership([instanceRow()]);
    stubEnvironment("org-2");

    const response = await post(`/sessions/${INSTANCE_UID}/events`, { content: "hi" });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "forbidden", message: "Not your organization's session" },
    });
  });

  // 归属全部通过时把用户事件发布到会话总线：响应回显后端记录的事件，载荷已按统一口径压平出 content。
  test("事件发送成功后发布到会话总线并返回规范化事件", async () => {
    const bus = getEventBus(INSTANCE_UID);
    stubInstanceOwnership([instanceRow()]);
    stubEnvironment("org-1");

    const response = await post(`/sessions/${INSTANCE_UID}/events`, {
      type: "user",
      message: { content: [{ type: "text", text: "你好" }] },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { status: string; event: Record<string, unknown> } };
    expect(body.data.status).toBe("ok");
    expect(body.data.event).toMatchObject({ sessionId: INSTANCE_UID, type: "user" });
    // 响应必须满足 `SessionEventSchema`：时间字段是 `timestamp`（由总线 `createdAt` 投影），
    // 早期直传总线对象会让这两条端点的成功路径固定返回 422（响应校验失败）。
    expect(typeof body.data.event.timestamp).toBe("number");
    expect((body.data.event.payload as Record<string, unknown>).content).toBe("你好");
    // 同一份事件确实进了总线，前端 SSE / WS 才可能看到。
    expect(bus.getEventsSince(0)).toHaveLength(1);
  });

  // 控制指令走同一条归属校验链，只换事件类型（缺省 control_request）。
  test("控制请求缺省类型为 control_request", async () => {
    const bus = getEventBus(INSTANCE_UID);
    stubInstanceOwnership([instanceRow()]);
    stubEnvironment("org-1");

    const response = await post(`/sessions/${INSTANCE_UID}/control`, { request_id: "req-1", approved: true });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { event: Record<string, unknown> } };
    expect(body.data.event).toMatchObject({ type: "control_request" });
    expect(bus.getEventsSince(0)).toHaveLength(1);
  });

  // 中断固定返回 null，并额外把会话状态置为 idle——后者以 session_status 事件的形式进总线。
  test("中断会话返回 null 并把状态置为 idle", async () => {
    const bus = getEventBus(INSTANCE_UID);
    stubInstanceOwnership([instanceRow()]);
    stubEnvironment("org-1");

    const response = await post(`/sessions/${INSTANCE_UID}/interrupt`, {});

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: null });
    const events = bus.getEventsSince(0);
    expect(events.map((event) => event.type)).toEqual(["interrupt", "session_status"]);
    expect(events[1]?.payload).toMatchObject({ status: "idle" });
  });

  // 环境未挂组织的实例对任何组织上下文都不可见（`organizationId` 为 null 不走拒绝分支，
  // 但同样不得被别的组织读到）——这里锁定「无组织环境」这一边界不被误判为跨组织。
  test("无组织归属的环境仍可命中（同一用户）", async () => {
    const bus = getEventBus(INSTANCE_UID);
    stubInstanceOwnership([instanceRow()]);
    stubEnvironment(null);

    const response = await post(`/sessions/${INSTANCE_UID}/events`, { content: "hi" });

    expect(response.status).toBe(200);
    expect(bus.getEventsSince(0)).toHaveLength(1);
  });
});
