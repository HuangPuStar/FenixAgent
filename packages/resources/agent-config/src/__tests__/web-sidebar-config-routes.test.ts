import { afterEach, describe, expect, test } from "bun:test";
import Elysia from "elysia";
import webSidebarConfig from "../routes/web/sidebar-config";

describe("web sidebar config routes", () => {
  const originalEnv = { ...process.env };
  const app = new Elysia().use(webSidebarConfig);

  afterEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
  });

  // GET /sidebar-config 返回解析后的隐藏 tab 列表
  test("GET /sidebar-config 返回 hiddenTabs", async () => {
    process.env.APP_HIDDEN_SIDEBAR_TABS = "models,mcp";

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
