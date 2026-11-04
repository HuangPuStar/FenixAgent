import { afterEach, expect, test } from "bun:test";
import { createApiMcpRoutes } from "../server/routes/api/mcp";
import { ApiMcpUpdateBodySchema } from "../server/schemas/api-mcp.schema";
import { toApiMcp } from "../server/services/api-v1-mcp";
import { authorizedServer, installMcpModuleStub, resetMcpModuleStub, testActor } from "./fixtures";
import { createStubMcpAuthGuardPlugin } from "./guard-stubs";

afterEach(resetMcpModuleStub);
// URL 中的凭据同样不可回显，历史非法地址不能使整个列表失败。
test("MCP read strips URL credentials and tolerates malformed legacy URLs", () => {
  const result = toApiMcp(
    authorizedServer({
      config: {
        type: "remote",
        url: "https://name:password@mcp.example.com/path?token=secret#fragment",
      },
    }),
  );
  expect(result.config.url).toBe("https://mcp.example.com/path");
  expect(result.summary).toBe("https://mcp.example.com");
  expect(toApiMcp(authorizedServer({ config: { type: "remote", url: "bad-legacy-url" } })).summary).toBe("");
});
// 配置替换必须完整，独立启停不得隐式清空凭据。
test("v1 MCP requires complete replacement and disallows mixed commands", () => {
  for (const input of [
    { config: { type: "local", timeout: 1 } },
    { enabled: false, config: { type: "local", command: ["tool"] } },
    {},
  ])
    expect(ApiMcpUpdateBodySchema.safeParse(input).success).toBe(false);
  expect(ApiMcpUpdateBodySchema.safeParse({ enabled: false }).success).toBe(true);
});
// 读配置只暴露凭据状态，启停保留原始连接信息。
test("v1 MCP masks secrets and toggle preserves config", async () => {
  const guard = createStubMcpAuthGuardPlugin();
  guard.setActor(testActor());
  const config = {
    type: "remote" as const,
    url: "https://mcp.example.com",
    headers: { Authorization: "secret-header" },
    oauth: { clientId: "client", clientSecret: "secret-oauth" },
  };
  let toggled = false;
  installMcpModuleStub({
    facade: {
      getById: async () => authorizedServer({ config, enabled: !toggled }),
      setEnabledById: async () => {
        toggled = true;
        return "mcp";
      },
    },
  });
  const app = createApiMcpRoutes({ authGuardPlugin: guard.plugin });
  const response = await app.handle(
    new Request("http://localhost/api/v1/mcp-servers/mcp-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }),
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.success).toBe(true);
  expect(body.data.enabled).toBe(false);
  expect(body.data.headerNames).toEqual(["Authorization"]);
  expect(body.data.hasClientSecret).toBe(true);
  expect(JSON.stringify(body)).not.toContain("secret-header");
  expect(JSON.stringify(body)).not.toContain("secret-oauth");
});
