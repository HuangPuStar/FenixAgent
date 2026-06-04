import { beforeEach, describe, expect, test } from "bun:test";
import { mcpServer, provider } from "../db/schema";
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

function providerRow(overrides: Record<string, unknown>) {
  return {
    id: "provider_internal",
    userId: "user_owner",
    organizationId: "org_current",
    name: "openai",
    displayName: "OpenAI",
    protocol: "openai" as const,
    baseUrl: "https://internal.example.com",
    apiKey: "internal-key",
    extraOptions: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function queryResult<T>(rows: T[]) {
  return Object.assign(Promise.resolve(rows), {
    limit: async () => rows,
  });
}

function installAggregateDb(params: {
  providerInternal?: unknown[];
  providerExternal?: unknown[];
  mcpRows?: unknown[];
}) {
  let providerCallCount = 0;
  stubDb({
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === provider) {
            providerCallCount += 1;
            return queryResult(
              providerCallCount === 1 ? (params.providerInternal ?? []) : (params.providerExternal ?? []),
            );
          }
          if (table === mcpServer) {
            return queryResult(params.mcpRows ?? []);
          }
          return queryResult([]);
        },
      }),
    }),
  });
}

describe("launch spec provider model access", () => {
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

  // getAgentFullConfig 会带上可读的外部 provider
  test("getAgentFullConfig 包含外部 provider", async () => {
    const internal = providerRow({ id: "provider_internal", organizationId: "org_current", apiKey: "internal-key" });
    const external = providerRow({
      id: "provider_external",
      organizationId: "org_source",
      userId: "user_source",
      apiKey: "external-key",
      baseUrl: "https://external.example.com",
    });
    installAggregateDb({ providerInternal: [internal], providerExternal: [external], mcpRows: [] });
    stubResourcePermissionRepo({
      listAccessibleForPrincipal: async (_orgId, resourceType) =>
        resourceType === "provider"
          ? [
              {
                organizationId: "org_source",
                resourceType: "provider",
                resourceId: "provider_external",
                hasPublicRead: true,
              },
            ]
          : [],
      listOwnedByOrganization: async () => [],
    });

    const fullConfig = await getAgentFullConfig(ctx, null);

    expect(fullConfig.providers.map((row) => row.resourceAccess?.resourceKey)).toEqual([
      "org_current/provider_internal",
      "org_source/provider_external",
    ]);
  });

  // 旧 provider/model 引用在同名 provider 存在时优先使用内部 provider
  test("旧 provider model 引用优先内部 provider", async () => {
    const spec = await buildLaunchSpec({
      organizationId: "org_current",
      userId: "user_owner",
      agentName: "demo",
      modelRef: "openai/gpt-4o",
      environmentSecret: "secret",
      fullConfig: {
        agentConfig: null,
        providers: [
          {
            ...providerRow({ id: "provider_external", organizationId: "org_source", apiKey: "external-key" }),
            resourceAccess: {
              ownership: "external",
              sourceOrganizationId: "org_source",
              resourceUid: "provider_external",
              resourceKey: "org_source/provider_external",
              manageable: false,
              writable: false,
            },
          },
          {
            ...providerRow({ id: "provider_internal", organizationId: "org_current", apiKey: "internal-key" }),
            resourceAccess: {
              ownership: "internal",
              sourceOrganizationId: "org_current",
              resourceUid: "provider_internal",
              resourceKey: "org_current/provider_internal",
              manageable: true,
              writable: true,
              publicReadable: false,
            },
          },
        ],
        skills: [],
        mcpServers: [],
      },
    });

    expect(spec.model).toMatchObject({
      provider: "openai",
      apiKey: "internal-key",
      baseUrl: "https://internal.example.com",
      model: "gpt-4o",
    });
  });

  // 稳定 sourceOrg/providerUid/model 引用解析到外部 provider 当前配置
  test("稳定 model 引用解析到外部 provider", async () => {
    const spec = await buildLaunchSpec({
      organizationId: "org_current",
      userId: "user_owner",
      agentName: "demo",
      modelRef: "org_source/provider_external/shared-model",
      environmentSecret: "secret",
      fullConfig: {
        agentConfig: null,
        providers: [
          {
            ...providerRow({
              id: "provider_external",
              organizationId: "org_source",
              apiKey: "external-key",
              baseUrl: "https://external.example.com",
            }),
            resourceAccess: {
              ownership: "external",
              sourceOrganizationId: "org_source",
              resourceUid: "provider_external",
              resourceKey: "org_source/provider_external",
              manageable: false,
              writable: false,
            },
          },
        ],
        skills: [],
        mcpServers: [],
      },
    });

    expect(spec.model).toMatchObject({
      provider: "openai",
      apiKey: "external-key",
      baseUrl: "https://external.example.com",
      model: "shared-model",
    });
  });
});
