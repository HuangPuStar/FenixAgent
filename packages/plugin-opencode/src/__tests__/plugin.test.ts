import { describe, expect, test } from "bun:test";
import { createEnginePlugin as createEnginePluginFromIndex } from "../index";
import { createEnginePlugin } from "../plugin";

describe("createEnginePlugin", () => {
  // createEnginePlugin() 返回固定 meta
  test("returns fixed plugin metadata", () => {
    const plugin = createEnginePlugin();

    expect(plugin.meta).toEqual({
      id: "opencode",
      displayName: "OpenCode Engine",
      version: "0.1.0",
    });
  });

  // createRuntime() 返回四段生命周期对象
  test("returns a runtime with the four lifecycle methods", () => {
    const runtime = createEnginePlugin().createRuntime();

    expect(runtime.prepareEnvironment).toBeFunction();
    expect(runtime.startInstance).toBeFunction();
    expect(runtime.connectRelay).toBeFunction();
    expect(runtime.stopInstance).toBeFunction();
  });

  // 包主入口稳定导出 createEnginePlugin
  test("re-exports createEnginePlugin from the package entry", () => {
    expect(createEnginePluginFromIndex).toBe(createEnginePlugin);
  });
});
