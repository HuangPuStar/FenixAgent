import { afterEach, describe, expect, test } from "bun:test";
import webHindsight from "../routes/web/hindsight";

describe("web hindsight routes", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
  });

  test("GET /hindsight/status 未配置时返回 enabled: false", async () => {
    delete process.env.HINDSIGHT_MCP_URL;
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/status"));
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.enabled).toBe(false);
  });

  test("GET /hindsight/status 配置后返回 enabled: true 和 url", async () => {
    process.env.HINDSIGHT_MCP_URL = "http://localhost:8888";
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/status"));
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.enabled).toBe(true);
    expect(json.data.url).toBe("http://localhost:8888");
  });
});
