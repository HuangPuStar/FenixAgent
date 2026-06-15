import { afterEach, describe, expect, test } from "bun:test";
import { getHindsightConfig } from "../services/hindsight";

describe("hindsight service", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
  });

  // getHindsightConfig
  test("未配置 HINDSIGHT_MCP_URL 返回 null", () => {
    delete process.env.HINDSIGHT_MCP_URL;
    expect(getHindsightConfig()).toBeNull();
  });

  test("配置 HINDSIGHT_MCP_URL 返回 url", () => {
    process.env.HINDSIGHT_MCP_URL = "http://localhost:8888";
    const config = getHindsightConfig();
    expect(config).toEqual({ url: "http://localhost:8888" });
  });
});
