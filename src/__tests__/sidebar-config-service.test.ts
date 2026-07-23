import { afterEach, describe, expect, test } from "bun:test";
import { getSidebarConfig } from "../services/sidebar-config";

describe("sidebar config service", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
  });

  // 未配置环境变量时返回空隐藏列表
  test("未配置时返回空 hiddenTabs", () => {
    delete process.env.APP_HIDDEN_SIDEBAR_TABS;

    expect(getSidebarConfig().hiddenTabs).toEqual([]);
  });

  // 解析时会 trim、去重，并保留原始 id 交给前端自行判断是否存在
  test("会保留未知 id 并去重", () => {
    process.env.APP_HIDDEN_SIDEBAR_TABS = " models, mcp ,models,invalid-tab,sites ";

    expect(getSidebarConfig().hiddenTabs).toEqual(["models", "mcp", "invalid-tab", "sites"]);
  });
});
