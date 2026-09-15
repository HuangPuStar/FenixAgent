import { describe, expect, test } from "bun:test";
import { buildTrustedOrigins } from "../auth/trusted-origins";

describe("trusted origins", () => {
  // 默认信任本地开发前端，并自动纳入对外 base URL。
  test("includes local dev origin and configured public URLs", () => {
    expect(
      buildTrustedOrigins({
        betterAuthUrl: "https://fenix-agent.pazhoulab-huangpu.com",
        rcsBaseUrl: "https://fenix-agent.pazhoulab-huangpu.com/",
      }),
    ).toEqual(["http://localhost:5173", "https://fenix-agent.pazhoulab-huangpu.com"]);
  });

  // 显式配置支持逗号分隔多个可信来源。
  test("parses comma-separated trusted origins", () => {
    expect(
      buildTrustedOrigins({
        trustedOrigins: "https://a.example.com, https://b.example.com/",
        rcsBaseUrl: "https://a.example.com",
      }),
    ).toEqual(["http://localhost:5173", "https://a.example.com", "https://b.example.com"]);
  });
});
