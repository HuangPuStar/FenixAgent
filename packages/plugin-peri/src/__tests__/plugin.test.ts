import { describe, expect, test } from "bun:test";
import { createEnginePlugin as createEnginePluginFromIndex } from "../index";
import { createEnginePlugin } from "../plugin";

describe("createEnginePlugin", () => {
  // createEnginePlugin() 返回固定 meta：引擎标识必须是 peri，编排域按此 id 解析本地引擎
  test("returns fixed plugin metadata", () => {
    const plugin = createEnginePlugin();

    expect(plugin.meta).toEqual({
      id: "peri",
      displayName: "Peri Engine (peri acp)",
      version: "0.1.0",
    });
  });

  // 命令与参数可被调用方覆盖（非默认安装路径或自定义 ACP 子命令）
  test("allows overriding command and args", () => {
    const plugin = createEnginePlugin({ command: "/opt/peri/bin/peri", args: ["acp", "--verbose"] });

    expect(plugin.meta.displayName).toBe("Peri Engine (/opt/peri/bin/peri acp --verbose)");
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
