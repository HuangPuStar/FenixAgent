import { describe, expect, test } from "bun:test";
import type { EnginePlugin } from "@mothership/plugin-sdk";
import { EnginePluginRegistry } from "../registry/engine-plugin-registry";

function createTestPlugin(engineType = "opencode"): EnginePlugin {
  return {
    meta: {
      id: engineType,
      displayName: `Test ${engineType}`,
      version: "0.1.0",
    },
    createRuntime() {
      return {
        async prepareEnvironment() {},
        async startInstance() {},
        async stopInstance() {},
        async connectRelay() {
          throw new Error("relay is not implemented in this fixture");
        },
      };
    },
  };
}

describe("EnginePluginRegistry", () => {
  // 注册后可通过各类查询接口取回同一插件
  test("registers and queries plugins by meta.id", () => {
    const registry = new EnginePluginRegistry();
    const plugin = createTestPlugin("opencode");

    expect(registry.register(plugin)).toBe(plugin);
    expect(registry.get("opencode")).toBe(plugin);
    expect(registry.require("opencode")).toBe(plugin);
    expect(registry.has("opencode")).toBe(true);
    expect(registry.list()).toEqual([plugin]);
  });

  // 重复注册同一插件时抛出具名错误码
  test("rejects duplicate plugin registration", () => {
    const registry = new EnginePluginRegistry();
    const plugin = createTestPlugin("opencode");

    registry.register(plugin);

    expect(() => registry.register(plugin)).toThrow(
      expect.objectContaining({
        code: "DUPLICATE_ENGINE_PLUGIN",
      }),
    );
  });

  // 未注册的 engine 查询返回 null，require 会抛错
  test("returns null for get and throws for missing require", () => {
    const registry = new EnginePluginRegistry();

    expect(registry.get("missing")).toBeNull();
    expect(registry.has("missing")).toBe(false);
    expect(() => registry.require("missing")).toThrow(
      expect.objectContaining({
        code: "PLUGIN_NOT_FOUND",
      }),
    );
  });
});
