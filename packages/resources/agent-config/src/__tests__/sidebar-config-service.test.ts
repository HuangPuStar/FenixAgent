import { afterEach, describe, expect, test } from "bun:test";
import { getSidebarConfig } from "../server/services/sidebar-config";
import { initializeAgentConfigModuleConfig } from "../server/testing";

/**
 * 侧边栏配置的读取与解析。
 *
 * 配置经宿主注入的模块配置读取（`getModuleConfig("agent-config")`），不再读 `process.env`：用例因此
 * 走 `initializeAgentConfigModuleConfig` 这条生产读取路径，而不是改环境变量——后者只能证明「模块
 * 读了环境」，证明不了「宿主传进来的值被正确解析」。
 */

describe("sidebar config service", () => {
  afterEach(() => {
    initializeAgentConfigModuleConfig();
  });

  // 未配置隐藏列表时返回空数组
  test("未配置时返回空 hiddenTabs", () => {
    initializeAgentConfigModuleConfig({ hiddenSidebarTabs: "" });

    expect(getSidebarConfig().hiddenTabs).toEqual([]);
  });

  // 解析时会 trim、去重，并保留原始 id 交给前端自行判断是否存在
  test("会保留未知 id 并去重", () => {
    initializeAgentConfigModuleConfig({ hiddenSidebarTabs: " models, mcp ,models,invalid-tab,sites " });

    expect(getSidebarConfig().hiddenTabs).toEqual(["models", "mcp", "invalid-tab", "sites"]);
  });
});
