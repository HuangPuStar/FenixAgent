import { describe, expect, test } from "bun:test";
import { CoreNodeRegistry } from "../registry/core-node-registry";

describe("CoreNodeRegistry", () => {
  // 注册 node 后返回副本并对 engineTypes 去重
  test("registers nodes and returns cloned node data", () => {
    const registry = new CoreNodeRegistry();

    const registered = registry.register({
      id: "local-default",
      mode: "local",
      engineTypes: ["opencode", "opencode"],
      status: "online",
      metadata: { region: "local" },
    });

    registered.engineTypes.push("mutated");

    expect(registry.get("local-default")).toEqual({
      id: "local-default",
      mode: "local",
      engineTypes: ["opencode"],
      status: "online",
      metadata: { region: "local" },
    });
    expect(registry.require("local-default")).toEqual({
      id: "local-default",
      mode: "local",
      engineTypes: ["opencode"],
      status: "online",
      metadata: { region: "local" },
    });
    expect(registry.list()).toEqual([
      {
        id: "local-default",
        mode: "local",
        engineTypes: ["opencode"],
        status: "online",
        metadata: { region: "local" },
      },
    ]);
  });

  // setStatus() 会持久化 node 的最新在线状态
  test("updates node status through setStatus", () => {
    const registry = new CoreNodeRegistry();

    registry.register({
      id: "local-default",
      mode: "local",
      engineTypes: ["opencode"],
      status: "online",
    });

    expect(registry.setStatus("local-default", "offline")).toEqual({
      id: "local-default",
      mode: "local",
      engineTypes: ["opencode"],
      status: "offline",
      metadata: undefined,
    });
    expect(registry.get("local-default")?.status).toBe("offline");
  });

  // supportsEngine() 会校验能力，缺失 node 时抛出具名错误
  test("reports supported engines and throws for missing nodes", () => {
    const registry = new CoreNodeRegistry();

    registry.register({
      id: "local-default",
      mode: "local",
      engineTypes: ["opencode"],
      status: "online",
    });

    expect(registry.supportsEngine("local-default", "opencode")).toBe(true);
    expect(registry.supportsEngine("local-default", "missing")).toBe(false);
    expect(() => registry.supportsEngine("missing-node", "opencode")).toThrow(
      expect.objectContaining({
        code: "NODE_NOT_FOUND",
      }),
    );
  });

  // 重复注册同一 node id 会抛出稳定错误码
  test("rejects duplicate node registration", () => {
    const registry = new CoreNodeRegistry();

    registry.register({
      id: "local-default",
      mode: "local",
      engineTypes: ["opencode"],
      status: "online",
    });

    expect(() =>
      registry.register({
        id: "local-default",
        mode: "local",
        engineTypes: ["opencode"],
        status: "online",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "DUPLICATE_CORE_NODE",
      }),
    );
  });
});
