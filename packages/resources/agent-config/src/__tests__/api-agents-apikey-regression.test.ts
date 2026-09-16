import { describe, expect, test } from "bun:test";

const setupMocksPath = new URL("../../../../../apps/server/src/test-utils/setup-mocks.ts", import.meta.url).pathname;
const routeModulePath = import.meta.resolve("../server/routes/api/agents");
const routeConfigTestDepsPath = import.meta.resolve(
  "../../../../../apps/server/src/test-utils/agent-config-route-deps",
);
const authModulePath = import.meta.resolve("../../../../../apps/server/src/plugins/auth");
const orgContextModulePath = import.meta.resolve("../../../../../apps/server/src/services/org-context");
const agentKnowledgeModulePath = import.meta.resolve("@fenix/resource-knowledge/server");
const helpersModulePath = import.meta.resolve("../../../../../apps/server/src/test-utils/helpers");
const moduleStubsPath = import.meta.resolve("../../../../../apps/server/src/test-utils/stubs/module-stubs");

describe("API agents API key regression", () => {
  // 仅带 API key、没有 session cookie 时，/api/agents 仍应通过 API key 恢复组织上下文。
  test("GET /api/agents accepts API key auth without session cookie", async () => {
    const script = `
      import { resetTestAuth } from ${JSON.stringify(authModulePath)};
      import { setTestOrgContext } from ${JSON.stringify(orgContextModulePath)};
      import { setListAgentKnowledgeBindingsById } from ${JSON.stringify(agentKnowledgeModulePath)};
      import { resetAllStubs, stubAuthApi, stubConfigPg, stubDb } from ${JSON.stringify(helpersModulePath)};
      import { installRouteConfigStubs } from ${JSON.stringify(routeConfigTestDepsPath)};
      import { stubEnvironmentRepo } from ${JSON.stringify(moduleStubsPath)};

      const apiAgentsRoute = (await import(${JSON.stringify(routeModulePath)})).default;

      const queryResult = (rows) => Object.assign(Promise.resolve(rows), {
        limit: async () => rows,
      });

      resetAllStubs();
      installRouteConfigStubs();
      resetTestAuth();
      setTestOrgContext(null);
      setListAgentKnowledgeBindingsById(async () => []);
      stubEnvironmentRepo({
        // 这条回归用例只覆盖 API key 链路，显式跳过 environment secret 探测。
        getBySecret: async () => null,
      });
      stubAuthApi({
        getSession: async () => null,
        verifyApiKey: async () => ({
          valid: true,
          key: {
            referenceId: "user-1",
            metadata: { organizationId: "org-1", role: "owner" },
          },
        }),
      });

      let selectCall = 0;
      stubDb({
        select: () => ({
          from: () => ({
            where: () => {
              selectCall += 1;
              if (selectCall === 1) {
                return queryResult([{ id: "user-1", email: "user@test.com", name: "Tester" }]);
              }
              return queryResult([{ id: "mem-1" }]);
            },
          }),
        }),
      });

      stubConfigPg({
        AGENT_SETTABLE_FIELDS: ["modelId", "prompt", "description", "extra", "agentNode", "knowledge"],
        listAgentConfigs: async () => [
          {
            id: "agc-internal",
            organizationId: "org-1",
            userId: "user-1",
            name: "internal-agent",
            model: "provider/model",
            modelId: "mdl-1",
            description: "internal",
            machineId: null,
            resourceAccess: {
              ownership: "internal",
              sourceOrganizationId: "org-1",
              resourceUid: "agc-internal",
              resourceKey: "org-1/agc-internal",
              manageable: true,
              writable: true,
              publicReadable: false,
            },
          },
        ],
      });

      const res = await apiAgentsRoute.handle(
        new Request("http://localhost/api/agents?page=1&pageSize=10", {
          headers: { Authorization: "Bearer rcs_demo_key" },
        }),
      );
      const body = await res.text();
      if (res.status !== 200) {
        console.error(body || "<empty body>");
        process.exit(1);
      }

      const json = JSON.parse(body);
      if (json.total !== 1 || json.items?.length !== 1 || json.items[0]?.id !== "agc-internal") {
        console.error(body);
        process.exit(1);
      }
    `;

    const proc = Bun.spawn(["bun", "--preload", setupMocksPath, "-e", script], {
      cwd: import.meta.dirname,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost",
      },
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });
});
