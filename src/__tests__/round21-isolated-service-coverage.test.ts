import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearAllCache, getCache, getCacheBackend } from "../services/cache";
import { eventService } from "../services/event-service";
import { clearOrgCache, loadOrgContext, setTestOrgContext } from "../services/org-context";
import { toInvocationDate } from "../services/scheduler/utils";
import { resetAllStubs, stubAuthApi, stubDb } from "../test-utils/helpers";
import { getAllEventBuses } from "../transport/event-bus";

const USER_ID = "user-round21";

function request(path = "/", headers?: Record<string, string>) {
  return new Request(`http://localhost${path}`, { headers });
}

function stubOrganizationName(name: string | null, fails = false) {
  stubDb({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (fails) throw new Error("database unavailable");
            return name ? [{ name }] : [];
          },
        }),
      }),
    }),
  });
}

function stubOrgAuth(members: unknown, organizations: unknown = [], onMembers?: () => void) {
  stubAuthApi({
    listMembers: async () => {
      onMembers?.();
      return members;
    },
    listOrganizations: async () => organizations,
  });
}

beforeEach(async () => {
  resetAllStubs();
  setTestOrgContext(null);
  await clearOrgCache();
  await clearAllCache();
});

afterEach(async () => {
  setTestOrgContext(null);
  await clearOrgCache();
  await clearAllCache();
  for (const [sessionId] of getAllEventBuses()) eventService.removeBus(sessionId);
});

describe("round21 隔离服务边界", () => {
  // 调度时间转换需要拒绝不可用输入。
  test.each([
    ["拒绝 null", null],
    ["拒绝 undefined", undefined],
    ["拒绝数字零", 0],
    ["拒绝空字符串", ""],
    ["拒绝普通对象", {}],
    ["拒绝非函数转换器", { toDate: "invalid" }],
  ])("调度时间%s", (_name, input) => expect(toInvocationDate(input)).toBeNull());

  // 调度时间转换需要兼容不同运行时对象。
  test("调度时间保留 Date", () => {
    const value = new Date("2026-01-01T00:00:00.000Z");
    expect(toInvocationDate(value)).toBe(value);
  });
  // 覆盖该独立行为与边界。
  test("调度时间支持 toDate", () => {
    const value = new Date("2026-02-01T00:00:00.000Z");
    expect(toInvocationDate({ toDate: () => value })).toBe(value);
  });
  // 覆盖该独立行为与边界。
  test("调度时间支持 toJSDate", () => {
    const value = new Date("2026-03-01T00:00:00.000Z");
    expect(toInvocationDate({ toJSDate: () => value })).toBe(value);
  });
  // 覆盖该独立行为与边界。
  test("调度时间优先 toDate", () => {
    const first = new Date("2026-04-01T00:00:00.000Z");
    expect(toInvocationDate({ toDate: () => first, toJSDate: () => new Date() })).toBe(first);
  });

  // 缓存必须按命名空间隔离并可释放。
  test("缓存默认使用内存后端", () => {
    getCache("round21-backend");
    expect(getCacheBackend()).toBe("memory");
  });
  // 覆盖该独立行为与边界。
  test("缓存复用同命名空间实例", () => expect(getCache("round21-reuse")).toBe(getCache("round21-reuse")));
  // 覆盖该独立行为与边界。
  test("缓存隔离命名空间", async () => {
    await getCache("round21-a").set("key", "a");
    await getCache("round21-b").set("key", "b");
    expect(String(await getCache("round21-a").get("key"))).toBe("a");
  });
  // 覆盖该独立行为与边界。
  test("缓存支持并发写入", async () => {
    const cache = getCache("round21-concurrent");
    await Promise.all([cache.set("first", 1), cache.set("second", 2)]);
    expect(await Promise.all([cache.get("first"), cache.get("second")])).toEqual([1, 2]);
  });
  // 覆盖该独立行为与边界。
  test("缓存删除仅影响目标键", async () => {
    const cache = getCache("round21-delete");
    await cache.set("first", 1);
    await cache.set("second", 2);
    await cache.delete("first");
    expect(String(await cache.get("second"))).toBe("2");
  });
  // 覆盖该独立行为与边界。
  test("缓存清理删除数据", async () => {
    const cache = getCache("round21-clear");
    await cache.set("key", "value");
    await clearAllCache();
    expect(await getCache("round21-clear").get("key")).toBeUndefined();
  });
  // 覆盖该独立行为与边界。
  test("缓存清理释放实例", async () => {
    const cache = getCache("round21-release");
    await clearAllCache();
    expect(getCache("round21-release")).not.toBe(cache);
  });

  // EventBus 注册表须支持 ACP 生命周期释放。
  test("事件服务创建 ACP 总线", () => {
    expect(eventService.getAcpBus("acp-round21")).toBe(eventService.getAcpBus("acp-round21"));
  });
  // 覆盖该独立行为与边界。
  test("事件服务释放 ACP 总线", () => {
    const bus = eventService.getAcpBus("acp-release");
    eventService.removeAcpBus("acp-release");
    expect(() =>
      bus.publish({ id: "closed", sessionId: "acp-release", type: "message", payload: null, direction: "inbound" }),
    ).toThrow("EventBus is closed");
  });
  // 同一会话的空游标与末尾游标应提供稳定分页。
  test("事件服务空会话返回空分页", () => expect(eventService.getEventsSince("empty-session", 0)).toEqual([]));
  // 覆盖该独立行为与边界。
  test("事件服务末尾游标返回空分页", () => {
    eventService.publishEvent("cursor-session", {
      id: "one",
      sessionId: "cursor-session",
      type: "message",
      payload: null,
      direction: "inbound",
    });
    expect(eventService.getEventsSince("cursor-session", 1)).toEqual([]);
  });
  // 发布需向每个独立订阅者送达相同事件。
  test("事件服务通知多个订阅者", () => {
    const first: string[] = [];
    const second: string[] = [];
    eventService.subscribe("multi-session", (event) => first.push(event.id));
    eventService.subscribe("multi-session", (event) => second.push(event.id));
    eventService.publishEvent("multi-session", {
      id: "one",
      sessionId: "multi-session",
      type: "message",
      payload: null,
      direction: "inbound",
    });
    expect([first, second]).toEqual([["one"], ["one"]]);
  });
  // 某一订阅者异常不应阻止其他订阅者。
  test("事件服务隔离订阅者异常", () => {
    const received: string[] = [];
    eventService.subscribe("error-session", () => {
      throw new Error("subscriber failed");
    });
    eventService.subscribe("error-session", (event) => received.push(event.id));
    eventService.publishEvent("error-session", {
      id: "one",
      sessionId: "error-session",
      type: "message",
      payload: null,
      direction: "inbound",
    });
    expect(received).toEqual(["one"]);
  });
  // getBus 返回可用于读取当前序号的同一实例。
  test("事件服务暴露当前总线", () => {
    eventService.publishEvent("bus-session", {
      id: "one",
      sessionId: "bus-session",
      type: "message",
      payload: null,
      direction: "inbound",
    });
    expect(eventService.getBus("bus-session").getLastSeqNum()).toBe(1);
  });
  // 删除不存在的总线必须幂等。
  test("事件服务重复删除安全", () => {
    eventService.removeBus("missing-session");
    expect(() => eventService.removeBus("missing-session")).not.toThrow();
  });
  // 注册表视图必须包含当前总线。
  test("事件服务列出当前总线", () => {
    eventService.getBus("listed-session");
    expect(eventService.getAllBuses().has("listed-session")).toBe(true);
  });
  // 创建多个缓存空间后清理必须全部释放。
  test("缓存清理释放全部命名空间", async () => {
    getCache("round21-all-a");
    getCache("round21-all-b");
    await clearAllCache();
    expect(getCache("round21-all-a")).not.toBe(getCache("round21-all-b"));
  });
  // 缓存可覆盖已有值以支持状态更新。
  test("缓存覆盖同一键状态", async () => {
    const cache = getCache("round21-overwrite");
    await cache.set("state", "pending");
    await cache.set("state", "complete");
    expect(String(await cache.get("state"))).toBe("complete");
  });

  // 组织授权必须遵循可信来源优先级与租户隔离。
  test("组织上下文优先测试注入", async () => {
    setTestOrgContext({ organizationId: "org-injected", userId: USER_ID, role: "owner" });
    expect(
      (
        await loadOrgContext(
          { id: USER_ID },
          request("/?activeOrganizationId=org-query", { "x-active-org-id": "org-header" }),
        )
      )?.organizationId,
    ).toBe("org-injected");
  });
  test.each([
    ["header", "/?activeOrganizationId=org-query", { "x-active-org-id": "org-header" }, "org-header"],
    ["query", "/?activeOrganizationId=org-query", undefined, "org-query"],
    ["cookie", "/", { cookie: "x=1; active_org_id=org-cookie" }, "org-cookie"],
  ])("组织上下文解析%s", async (_name, path, headers, expected) => {
    stubOrganizationName("Org");
    stubOrgAuth([{ userId: USER_ID, role: "owner" }]);
    expect((await loadOrgContext({ id: USER_ID }, request(path, headers)))?.organizationId).toBe(expected);
  });
  // 覆盖该独立行为与边界。
  test("组织上下文兼容包装 members", async () => {
    stubOrganizationName("Wrapped");
    stubOrgAuth({ members: [{ userId: USER_ID, role: "admin" }] });
    expect((await loadOrgContext({ id: USER_ID }, request("/?activeOrganizationId=org-wrapped")))?.role).toBe("admin");
  });
  // 覆盖该独立行为与边界。
  test("组织名称加载失败仍返回成员", async () => {
    stubOrganizationName(null, true);
    stubOrgAuth([{ userId: USER_ID, role: "member" }]);
    expect(await loadOrgContext({ id: USER_ID }, request("/?activeOrganizationId=org-db-failure"))).toMatchObject({
      organizationId: "org-db-failure",
      role: "member",
    });
  });
  // 指定组织存在当前成员时不得错误回退到其他组织。
  test("组织上下文保留已授权指定组织", async () => {
    stubOrgAuth([{ userId: USER_ID, role: "admin" }], [{ id: "org-fallback", name: "Fallback" }]);
    expect(await loadOrgContext({ id: USER_ID }, request("/?activeOrganizationId=org-forbidden"))).toMatchObject({
      organizationId: "org-forbidden",
      role: "admin",
    });
  });
  // 覆盖该独立行为与边界。
  test("组织上下文无组织返回空", async () => {
    stubOrgAuth([], []);
    expect(await loadOrgContext({ id: USER_ID }, request())).toBeNull();
  });
  // 覆盖该独立行为与边界。
  test("组织上下文回退无成员返回空", async () => {
    stubOrgAuth([], [{ id: "org-first", name: "First" }]);
    expect(await loadOrgContext({ id: USER_ID }, request())).toBeNull();
  });
  // 覆盖该独立行为与边界。
  test("组织上下文认证异常返回空", async () => {
    stubAuthApi({ listOrganizations: async () => Promise.reject(new Error("unavailable")) });
    expect(await loadOrgContext({ id: USER_ID }, request())).toBeNull();
  });
  // 覆盖该独立行为与边界。
  test("组织上下文缓存避免重复查询", async () => {
    let calls = 0;
    stubOrganizationName("Cached");
    stubOrgAuth([{ userId: USER_ID, role: "owner" }], [], () => calls++);
    const input = request("/?activeOrganizationId=org-cached");
    await loadOrgContext({ id: USER_ID }, input);
    await loadOrgContext({ id: USER_ID }, input);
    expect(calls).toBe(1);
  });
  // 覆盖该独立行为与边界。
  test("组织上下文切换组织重新校验", async () => {
    let calls = 0;
    stubOrganizationName("Switch");
    stubOrgAuth([{ userId: USER_ID, role: "owner" }], [], () => calls++);
    await loadOrgContext({ id: USER_ID }, request("/?activeOrganizationId=org-a"));
    await loadOrgContext({ id: USER_ID }, request("/?activeOrganizationId=org-b"));
    expect(calls).toBe(2);
  });
  // 覆盖该独立行为与边界。
  test("组织上下文清理缓存后重新查询", async () => {
    let calls = 0;
    stubOrganizationName("Clear");
    stubOrgAuth([{ userId: USER_ID, role: "owner" }], [], () => calls++);
    const input = request("/?activeOrganizationId=org-clear");
    await loadOrgContext({ id: USER_ID }, input);
    await clearOrgCache();
    await loadOrgContext({ id: USER_ID }, input);
    expect(calls).toBe(2);
  });

  // 事件服务要隔离分页、订阅与释放生命周期。
  test("事件服务按游标分页", () => {
    eventService.publishEvent("session-events", {
      id: "one",
      sessionId: "session-events",
      type: "message",
      payload: {},
      direction: "inbound",
    });
    const second = eventService.publishEvent("session-events", {
      id: "two",
      sessionId: "session-events",
      type: "message",
      payload: {},
      direction: "outbound",
    });
    expect(eventService.getEventsSince("session-events", 1)).toEqual([second]);
  });
  // 覆盖该独立行为与边界。
  test("事件服务释放订阅", () => {
    const received: string[] = [];
    const unsubscribe = eventService.subscribe("session-subscribe", (event) => received.push(event.id));
    eventService.publishEvent("session-subscribe", {
      id: "first",
      sessionId: "session-subscribe",
      type: "message",
      payload: null,
      direction: "inbound",
    });
    unsubscribe();
    eventService.publishEvent("session-subscribe", {
      id: "second",
      sessionId: "session-subscribe",
      type: "message",
      payload: null,
      direction: "inbound",
    });
    expect(received).toEqual(["first"]);
  });
  // 覆盖该独立行为与边界。
  test("事件服务删除总线释放资源", () => {
    const bus = eventService.getBus("session-release");
    eventService.removeBus("session-release");
    expect(getAllEventBuses().has("session-release")).toBe(false);
    expect(() =>
      bus.publish({ id: "after", sessionId: "session-release", type: "message", payload: null, direction: "inbound" }),
    ).toThrow("EventBus is closed");
  });
  // 覆盖该独立行为与边界。
  test("事件服务隔离会话分页", () => {
    eventService.publishEvent("session-a", {
      id: "a",
      sessionId: "session-a",
      type: "message",
      payload: null,
      direction: "inbound",
    });
    eventService.publishEvent("session-b", {
      id: "b",
      sessionId: "session-b",
      type: "message",
      payload: null,
      direction: "inbound",
    });
    expect(eventService.getEventsSince("session-a", 0).map((event) => event.id)).toEqual(["a"]);
  });
});
