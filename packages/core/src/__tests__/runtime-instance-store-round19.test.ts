import { describe, expect, test } from "bun:test";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { createRuntimeInstanceStore, type RuntimeClock } from "../runtime/runtime-instance-store";
import { createFakeEnginePlugin } from "./fixtures/fake-engine-plugin";

function createLaunchSpec(overrides: Partial<AgentLaunchSpec> = {}): AgentLaunchSpec {
  return {
    organizationId: "org-round19",
    userId: "user-round19",
    environmentId: "env-round19",
    env: { FEATURE_FLAG: "enabled" },
    agent: { name: "writer", prompt: "Keep output concise", extra: { retries: 1 } },
    model: {
      provider: "openai",
      protocol: "openai",
      baseUrl: "https://api.example.test/v1",
      apiKey: "test-key",
      model: "test-model",
      modelName: "Test Model",
    },
    skills: [{ name: "writer", url: "https://skills.example.test/writer.zip" }],
    mcpServers: [
      {
        name: "local-tools",
        type: "stdio",
        command: "tool-server",
        args: ["--safe"],
        env: { LOG_LEVEL: "info" },
      },
      {
        name: "remote-tools",
        type: "streamable-http",
        url: "https://mcp.example.test",
        headers: { "x-tenant": "org-round19" },
        oauth: { clientId: "client-round19" },
      },
    ],
    ...overrides,
  };
}

function createClock(): RuntimeClock {
  let tick = 0;
  return () => new Date(`2026-08-19T00:${String(tick++).padStart(2, "0")}:00.000Z`);
}

function createStore() {
  return createRuntimeInstanceStore({ now: createClock() });
}

function createInput(instanceId = "inst-round19") {
  return {
    instanceId,
    engineType: "fake-engine",
    nodeId: "node-round19",
    launchSpec: createLaunchSpec(),
  };
}

describe("RuntimeInstanceStore round19 isolation", () => {
  // 新建记录默认处于 created 状态且未连接 relay。
  test("创建记录初始化生命周期状态", () => {
    const snapshot = createStore().create(createInput());

    expect(snapshot).toMatchObject({ status: "created", relayConnected: false });
  });

  // 新建记录会保留调用方提供的实例路由标识。
  test("创建记录保留实例路由字段", () => {
    const snapshot = createStore().create(createInput("inst-routing"));

    expect(snapshot).toMatchObject({ instanceId: "inst-routing", engineType: "fake-engine", nodeId: "node-round19" });
  });

  // 注入时钟使 createdAt 与 updatedAt 使用同一创建时刻。
  test("创建记录使用同一初始时间戳", () => {
    const snapshot = createStore().create(createInput());

    expect(snapshot.createdAt).toEqual(snapshot.updatedAt);
  });

  // get 对未知实例返回 null 而不是构造空记录。
  test("查询未知实例返回空值", () => {
    expect(createStore().get("missing")).toBeNull();
  });

  // require 对未知实例返回可供上层处理的稳定错误码。
  test("强制查询未知实例抛出稳定错误", () => {
    expect(() => createStore().require("missing")).toThrow(expect.objectContaining({ code: "INSTANCE_NOT_FOUND" }));
  });

  // 重复实例 ID 不能覆盖既有记录。
  test("重复创建实例被拒绝", () => {
    const store = createStore();
    store.create(createInput());

    expect(() => store.create(createInput())).toThrow(expect.objectContaining({ code: "INSTANCE_ALREADY_EXISTS" }));
  });

  // list 在空 store 上提供可安全遍历的空集合。
  test("空 store 返回空列表", () => {
    expect(createStore().list()).toEqual([]);
  });

  // list 按插入顺序返回全部独立实例。
  test("列表保留多个实例", () => {
    const store = createStore();
    store.create(createInput("inst-a"));
    store.create(createInput("inst-b"));

    expect(store.list().map(({ instanceId }) => instanceId)).toEqual(["inst-a", "inst-b"]);
  });

  // 可选 env 缺失时仍能创建并返回未定义值。
  test("创建记录支持缺失可选环境变量", () => {
    const store = createStore();
    store.create({ ...createInput(), launchSpec: createLaunchSpec({ env: undefined }) });

    expect(store.get("inst-round19")?.launchSpec.env).toBeUndefined();
  });

  // get 返回的顶层快照变更不会写回 store。
  test("get 快照隔离顶层状态", () => {
    const store = createStore();
    store.create(createInput());
    const snapshot = store.get("inst-round19");
    if (!snapshot) throw new Error("expected snapshot");
    const writable = snapshot as { status: "error" };
    writable.status = "error";

    expect(store.get("inst-round19")?.status).toBe("created");
  });

  // get 返回的 Date 副本不能改写内部时间戳。
  test("get 快照隔离创建时间", () => {
    const store = createStore();
    store.create(createInput());
    const snapshot = store.get("inst-round19");
    if (!snapshot) throw new Error("expected snapshot");
    snapshot.createdAt.setFullYear(2000);

    expect(store.get("inst-round19")?.createdAt.getUTCFullYear()).toBe(2026);
  });

  // list 返回的 launchSpec 嵌套环境变量不能污染记录。
  test("列表快照隔离环境变量", () => {
    const store = createStore();
    store.create(createInput());
    const snapshot = store.list()[0];
    if (!snapshot?.launchSpec.env) throw new Error("expected environment");
    snapshot.launchSpec.env.FEATURE_FLAG = "changed";

    expect(store.get("inst-round19")?.launchSpec.env?.FEATURE_FLAG).toBe("enabled");
  });

  // 创建后调用方继续改写 launchSpec 不会污染 store。
  test("创建时复制调用方启动配置", () => {
    const store = createStore();
    const input = createInput();
    store.create(input);
    input.launchSpec.agent.name = "changed";

    expect(store.get("inst-round19")?.launchSpec.agent.name).toBe("writer");
  });

  // stdio MCP 参数数组在创建边界得到隔离。
  test("创建时复制 stdio 参数数组", () => {
    const store = createStore();
    const input = createInput();
    store.create(input);
    const server = input.launchSpec.mcpServers[0];
    if (server?.type !== "stdio" || !server.args) throw new Error("expected stdio args");
    server.args.push("--changed");

    const stored = store.get("inst-round19")?.launchSpec.mcpServers[0];
    expect(stored?.type === "stdio" ? stored.args : undefined).toEqual(["--safe"]);
  });

  // stdio MCP 环境变量在创建边界得到隔离。
  test("创建时复制 stdio 环境变量", () => {
    const store = createStore();
    const input = createInput();
    store.create(input);
    const server = input.launchSpec.mcpServers[0];
    if (server?.type !== "stdio" || !server.env) throw new Error("expected stdio environment");
    server.env.LOG_LEVEL = "debug";

    const stored = store.get("inst-round19")?.launchSpec.mcpServers[0];
    expect(stored?.type === "stdio" ? stored.env?.LOG_LEVEL : undefined).toBe("info");
  });

  // HTTP MCP headers 在创建边界得到隔离。
  test("创建时复制 HTTP 请求头", () => {
    const store = createStore();
    const input = createInput();
    store.create(input);
    const server = input.launchSpec.mcpServers[1];
    if (server?.type !== "streamable-http" || !server.headers) throw new Error("expected HTTP headers");
    server.headers["x-tenant"] = "other-org";

    const stored = store.get("inst-round19")?.launchSpec.mcpServers[1];
    expect(stored?.type === "streamable-http" ? stored.headers?.["x-tenant"] : undefined).toBe("org-round19");
  });

  // update 会推进状态并更新更新时间。
  test("更新状态刷新更新时间", () => {
    const store = createStore();
    const created = store.create(createInput());
    const updated = store.update("inst-round19", { status: "preparing" });

    expect(updated.updatedAt > created.updatedAt).toBe(true);
  });

  // 只更新 relayConnected 时保留原有状态。
  test("更新连接标记保留状态", () => {
    const store = createStore();
    store.create(createInput());

    expect(store.update("inst-round19", { relayConnected: true })).toMatchObject({
      status: "created",
      relayConnected: true,
    });
  });

  // error 状态保存本次错误信息。
  test("错误状态保存错误信息", () => {
    const store = createStore();
    store.create(createInput());

    expect(store.update("inst-round19", { status: "error", errorMessage: "prepare failed" }).errorMessage).toBe(
      "prepare failed",
    );
  });

  // 非 error 状态不应残留历史错误信息。
  test("离开错误状态清理错误信息", () => {
    const store = createStore();
    store.create(createInput());
    store.update("inst-round19", { status: "error", errorMessage: "prepare failed" });

    expect(store.update("inst-round19", { status: "running" }).errorMessage).toBeUndefined();
  });

  // error 状态未提供新消息时保留诊断上下文。
  test("错误状态保留已有错误信息", () => {
    const store = createStore();
    store.create(createInput());
    store.update("inst-round19", { status: "error", errorMessage: "prepare failed" });

    expect(store.update("inst-round19", { status: "error" }).errorMessage).toBe("prepare failed");
  });

  // update 的完整 launchSpec 会替换旧值。
  test("更新替换启动配置", () => {
    const store = createStore();
    store.create(createInput());
    const refreshed = createLaunchSpec({ environmentId: "env-refreshed" });

    expect(store.update("inst-round19", { launchSpec: refreshed }).launchSpec.environmentId).toBe("env-refreshed");
  });

  // update 时复制新 launchSpec，避免刷新调用方后续修改泄漏。
  test("更新隔离新的启动配置", () => {
    const store = createStore();
    store.create(createInput());
    const refreshed = createLaunchSpec();
    store.update("inst-round19", { launchSpec: refreshed });
    refreshed.skills[0]!.name = "changed";

    expect(store.get("inst-round19")?.launchSpec.skills[0]?.name).toBe("writer");
  });

  // pluginMetadata 可写入插件侧补充状态。
  test("更新保存插件元数据", () => {
    const store = createStore();
    store.create(createInput());

    expect(store.update("inst-round19", { pluginMetadata: { port: 4312 } }).pluginMetadata).toEqual({ port: 4312 });
  });

  // 未提供 pluginMetadata 时保留此前已保存的元数据。
  test("更新保留已有插件元数据", () => {
    const store = createStore();
    store.create(createInput());
    store.update("inst-round19", { pluginMetadata: { port: 4312 } });

    expect(store.update("inst-round19", { status: "prepared" }).pluginMetadata).toEqual({ port: 4312 });
  });

  // 更新未知实例应稳定失败，避免隐式创建错误记录。
  test("更新未知实例被拒绝", () => {
    expect(() => createStore().update("missing", { status: "running" })).toThrow(
      expect.objectContaining({ code: "INSTANCE_NOT_FOUND" }),
    );
  });

  // 未附加 runtime 时读取缓存返回空值。
  test("未附加 runtime 时缓存为空", () => {
    expect(createStore().getRuntimeEntry("missing")).toBeNull();
  });

  // 只能向已创建实例附加 runtime 句柄。
  test("向未知实例附加 runtime 被拒绝", () => {
    const plugin = createFakeEnginePlugin();
    expect(() =>
      createStore().attachRuntime("missing", { plugin, runtime: plugin.createRuntime(), relay: null }),
    ).toThrow(expect.objectContaining({ code: "INSTANCE_NOT_FOUND" }));
  });

  // runtime 缓存会保存 plugin、runtime 与空 relay。
  test("附加 runtime 后可读取缓存", () => {
    const store = createStore();
    const plugin = createFakeEnginePlugin();
    store.create(createInput());
    store.attachRuntime("inst-round19", { plugin, runtime: plugin.createRuntime(), relay: null });

    expect(store.getRuntimeEntry("inst-round19")).toMatchObject({ plugin, relay: null });
  });

  // getRuntimeEntry 返回的新对象不能替换内部 relay 引用。
  test("runtime 缓存条目对象与内部状态隔离", () => {
    const store = createStore();
    const plugin = createFakeEnginePlugin();
    store.create(createInput());
    store.attachRuntime("inst-round19", { plugin, runtime: plugin.createRuntime(), relay: null });
    const entry = store.getRuntimeEntry("inst-round19");
    if (!entry) throw new Error("expected runtime entry");
    entry.relay = plugin.runtimeState.relay;

    expect(store.getRuntimeEntry("inst-round19")?.relay).toBeNull();
  });

  // setRelay 会缓存句柄并同步记录中的连接状态。
  test("设置 relay 同步连接状态", () => {
    const store = createStore();
    const plugin = createFakeEnginePlugin();
    store.create(createInput());
    store.attachRuntime("inst-round19", { plugin, runtime: plugin.createRuntime(), relay: null });

    expect(store.setRelay("inst-round19", plugin.runtimeState.relay).relay).toBe(plugin.runtimeState.relay);
    expect(store.get("inst-round19")?.relayConnected).toBe(true);
  });

  // 未附加 runtime 的实例不得接受 relay，避免孤立连接。
  test("没有 runtime 时设置 relay 被拒绝", () => {
    const store = createStore();
    store.create(createInput());
    const relay = createFakeEnginePlugin().runtimeState.relay;

    expect(() => store.setRelay("inst-round19", relay)).toThrow(
      expect.objectContaining({ code: "INSTANCE_NOT_FOUND" }),
    );
  });

  // clearRelay 会保留 runtime 缓存但移除 relay 句柄。
  test("清理 relay 保留 runtime 缓存", () => {
    const store = createStore();
    const plugin = createFakeEnginePlugin();
    store.create(createInput());
    store.attachRuntime("inst-round19", { plugin, runtime: plugin.createRuntime(), relay: plugin.runtimeState.relay });
    store.setRelay("inst-round19", plugin.runtimeState.relay);

    expect(store.clearRelay("inst-round19")?.runtime).toBe(plugin.createRuntime());
    expect(store.getRuntimeEntry("inst-round19")?.relay).toBeNull();
  });

  // clearRelay 会把记录标记为未连接。
  test("清理 relay 同步断开状态", () => {
    const store = createStore();
    const plugin = createFakeEnginePlugin();
    store.create(createInput());
    store.attachRuntime("inst-round19", { plugin, runtime: plugin.createRuntime(), relay: null });
    store.setRelay("inst-round19", plugin.runtimeState.relay);
    store.clearRelay("inst-round19");

    expect(store.get("inst-round19")?.relayConnected).toBe(false);
  });

  // 对没有缓存的实例清理 relay 是安全幂等操作。
  test("清理缺失 relay 返回空值", () => {
    const store = createStore();
    store.create(createInput());

    expect(store.clearRelay("inst-round19")).toBeNull();
  });

  // 删除已有实例同时移除可查询的记录。
  test("删除已有实例返回成功", () => {
    const store = createStore();
    store.create(createInput());

    expect(store.delete("inst-round19")).toBe(true);
    expect(store.get("inst-round19")).toBeNull();
  });

  // 删除未知实例返回 false，支持无副作用清理。
  test("删除未知实例返回失败标记", () => {
    expect(createStore().delete("missing")).toBe(false);
  });

  // 删除记录还会清除关联 runtime 缓存，避免句柄泄漏。
  test("删除实例清理 runtime 缓存", () => {
    const store = createStore();
    const plugin = createFakeEnginePlugin();
    store.create(createInput());
    store.attachRuntime("inst-round19", { plugin, runtime: plugin.createRuntime(), relay: null });

    store.delete("inst-round19");

    expect(store.getRuntimeEntry("inst-round19")).toBeNull();
  });

  // 删除后相同实例 ID 可创建全新记录，不复用旧状态。
  test("删除后允许重新创建相同实例", () => {
    const store = createStore();
    store.create(createInput());
    store.update("inst-round19", { status: "error", errorMessage: "old failure" });
    store.delete("inst-round19");

    expect(store.create(createInput())).toMatchObject({ status: "created", errorMessage: undefined });
  });

  // 不同实例的状态更新彼此隔离。
  test("多个实例的状态彼此隔离", () => {
    const store = createStore();
    store.create(createInput("inst-a"));
    store.create(createInput("inst-b"));
    store.update("inst-a", { status: "running" });

    expect(store.get("inst-a")?.status).toBe("running");
    expect(store.get("inst-b")?.status).toBe("created");
  });
});
