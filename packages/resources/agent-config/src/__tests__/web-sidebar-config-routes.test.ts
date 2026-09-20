import { afterEach, describe, expect, test } from "bun:test";
import { createWebSidebarConfigRoutes } from "../server/routes/web/sidebar-config";
import { initializeAgentConfigModuleConfig } from "../server/testing";

/**
 * `/web/sidebar-config` 路由。
 *
 * 工厂无依赖（该端点在登录页也要可用，刻意不声明 `sessionAuth`），因此这里直接调用工厂，不注入
 * 守卫替身；配置经 `initializeAgentConfigModuleConfig` 注入。
 */

const app = createWebSidebarConfigRoutes();

describe("web sidebar config routes", () => {
  afterEach(() => {
    initializeAgentConfigModuleConfig();
  });

  // GET /sidebar-config 返回解析后的隐藏 tab 列表
  test("GET /sidebar-config 返回 hiddenTabs", async () => {
    initializeAgentConfigModuleConfig({ hiddenSidebarTabs: "models,mcp" });

    const response = await app.handle(new Request("http://localhost/sidebar-config"));
    const payload = (await response.json()) as {
      success: boolean;
      data: { hiddenTabs: string[] };
    };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data.hiddenTabs).toEqual(["models", "mcp"]);
  });
});
