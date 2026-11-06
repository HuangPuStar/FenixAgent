import { expect, test } from "bun:test";
import { createAppWithDatabase } from "../app";
import { loadConfig } from "../config";
import { createDatabase } from "../db/client";
import { migrateConnection } from "../db/migrate";

interface Spec {
  openapi: string;
  security: unknown;
  components: {
    securitySchemes: { BearerAuth: { scheme: string } };
    schemas: Record<
      string,
      { properties: Record<string, { description: string }>; required?: string[]; oneOf?: unknown[] }
    >;
  };
  paths: Record<
    string,
    Record<
      string,
      {
        security: unknown;
        parameters: { name: string }[];
        requestBody: { content: Record<string, { schema: unknown }> };
        responses: Record<number, { content: Record<string, unknown> }>;
      }
    >
  >;
}

// 文档可直接访问，完整描述管理接口和认证，但不暴露内部回调或密钥。
test("serves OpenAPI site and a usable public schema without weakening API authentication", async () => {
  const h = createDatabase(":memory:");
  try {
    migrateConnection(h.db, h.sqlite);
    const config = loadConfig({
      SERVER_API_KEY_ENCRYPTION_KEY: "0".repeat(32),
      CLUSTER_SERVICE_API_KEY: "private-cluster-key",
      FRP_TOKEN: "private-frp-key",
      FRP_PUBLIC_ADDRESS: "localhost",
    });
    const app = createAppWithDatabase(config, h.db, h.sqlite);
    const read = (path: string) => app.handle(new Request(`http://cluster${path}`));
    const site = await read("/openapi");
    expect(site.status).toBe(200);
    expect(site.headers.get("content-type")).toContain("text/html");
    expect(await site.text()).toContain("/openapi/json");
    const response = await read("/openapi/json");
    expect(response.status).toBe(200);
    const spec = (await response.json()) as Spec;
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.security).toEqual([{ BearerAuth: [] }]);
    expect(spec.components.securitySchemes.BearerAuth.scheme).toBe("bearer");
    expect(spec.paths["/api/v1/pools"].post.requestBody.content["application/json"].schema).toBeDefined();
    expect(spec.components.schemas.ServerInput.properties.disk_capacity_gb.description).toContain("GB");
    expect(spec.components.schemas.ServerInput.required).not.toContain("base_url");
    expect(spec.components.schemas.ServerInput.oneOf).toEqual([
      { properties: { transport_mode: { enum: ["direct"] } }, required: ["base_url"] },
      { properties: { transport_mode: { enum: ["tunnel"] } }, required: ["transport_mode"] },
    ]);
    expect(
      spec.paths["/api/v1/servers/{serverId}/tunnel/frpc.toml"].get.responses[200].content["application/toml"],
    ).toBeDefined();
    expect(spec.paths["/api/v2/pools/{poolId}/sandboxes"].post.responses[201]).toBeDefined();
    expect(spec.paths["/api/v1/servers/{serverId}/unbound-sandboxes"].get.responses[200]).toBeDefined();
    expect(spec.paths["/api/v1/servers/{serverId}/unbound-sandboxes/{sandboxId}"].delete.responses[204]).toBeDefined();
    expect(
      spec.paths["/api/v1/sandbox-allocations"].get.parameters.some((p: { name: string }) => p.name === "pageSize"),
    ).toBe(true);
    expect(spec.paths["/health"].get.security).toEqual([]);
    expect(
      Object.keys(spec.paths).some((path) => path.includes("internal") || path.includes("*") || path === "/"),
    ).toBe(false);
    expect(JSON.stringify(spec)).not.toContain("private-cluster-key");
    expect(JSON.stringify(spec)).not.toContain("private-frp-key");
    expect((await read("/api/v1/pools")).status).toBe(401);
  } finally {
    h.sqlite.close();
  }
});
