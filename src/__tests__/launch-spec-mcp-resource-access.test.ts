import { beforeEach, describe, expect, test } from "bun:test";
import type { AuthContext } from "../plugins/auth";
import { getAgentFullConfig } from "../services/config/aggregate";
import { buildLaunchSpec } from "../services/launch-spec-builder";
import { setOrganizationRepoForTesting } from "../services/resource-permission";
import { resetAllStubs, stubDb, stubResourcePermissionRepo } from "../test-utils/helpers";

const ctx: AuthContext = {
  organizationId: "org_current",
  userId: "user_owner",
  role: "owner",
};

const now = new Date("2026-06-01T00:00:00.000Z");

function queryResult<T>(rows: T[]) {
  return Object.assign(Promise.resolve(rows), {
    limit: async () => rows,
  });
}

describe("launch spec MCP resource access", () => {
  beforeEach(() => {
    resetAllStubs();
    setOrganizationRepoForTesting({
      listNamesByIds: async () =>
        new Map([
          ["org_current", "Current Team"],
          ["org_source", "Source Team"],
        ]),
    });
  });

  // getAgentFullConfig 会带上可读的外部 enabled MCP，并过滤 disabled 外部 MCP
  test("getAgentFullConfig 包含外部 enabled MCP", async () => {
    const providerRows: unknown[] = [];
    const internalMcpRows = [
      {
        id: "mcp_internal",
        userId: "user_owner",
        organizationId: "org_current",
        name: "internal",
        type: "remote",
        config: { type: "remote", url: "https://internal.example.com" },
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ];
    const skillRows: unknown[] = [];
    const externalRows = [
      {
        id: "mcp_external_enabled",
        userId: "user_source",
        organizationId: "org_source",
        name: "external-enabled",
        type: "remote",
        config: { type: "remote", url: "https://external.example.com" },
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "mcp_external_disabled",
        userId: "user_source",
        organizationId: "org_source",
        name: "external-disabled",
        type: "remote",
        config: { type: "remote", url: "https://disabled.example.com" },
        enabled: false,
        createdAt: now,
        updatedAt: now,
      },
    ];

    let selectCount = 0;
    stubDb({
      select: () => ({
        from: () => ({
          where: () => {
            selectCount += 1;
            if (selectCount === 1) return queryResult(providerRows);
            if (selectCount === 2) return queryResult(internalMcpRows);
            if (selectCount === 3) return queryResult(skillRows);
            return queryResult(externalRows);
          },
        }),
      }),
    });
    stubResourcePermissionRepo({
      listAccessibleForPrincipal: async () => [
        {
          organizationId: "org_source",
          resourceType: "mcp_server",
          resourceId: "mcp_external_enabled",
          hasPublicRead: true,
        },
        {
          organizationId: "org_source",
          resourceType: "mcp_server",
          resourceId: "mcp_external_disabled",
          hasPublicRead: true,
        },
      ],
      listOwnedByOrganization: async () => [],
    });

    const fullConfig = await getAgentFullConfig(ctx, null);

    expect(fullConfig.mcpServers.map((server) => server.name)).toEqual(["internal", "external-enabled"]);
  });

  // buildLaunchSpec 会把外部 MCP 配置正常转换到 SDK mcpServers
  test("buildLaunchSpec 转换外部 MCP 配置", async () => {
    const spec = await buildLaunchSpec({
      organizationId: "org_current",
      userId: "user_owner",
      environmentId: "env_1",
      agentName: "demo",
      agentConfigId: null,
      agentPrompt: null,
      modelRef: null,
      environmentSecret: "secret",
      fullConfig: {
        agentConfig: null,
        providers: [],
        skills: [],
        mcpServers: [
          {
            id: "mcp_external_enabled",
            userId: "user_source",
            organizationId: "org_source",
            name: "external-enabled",
            type: "remote",
            config: { type: "remote", url: "https://external.example.com", headers: { Authorization: "Bearer x" } },
            enabled: true,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    });

    expect(spec.mcpServers).toEqual([
      {
        name: "external-enabled",
        type: "streamable-http",
        url: "https://external.example.com",
        headers: { Authorization: "Bearer x" },
        timeout: undefined,
      },
    ]);
  });
});
