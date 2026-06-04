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

const now = new Date("2026-06-04T00:00:00.000Z");

function queryResult<T>(rows: T[]) {
  return Object.assign(Promise.resolve(rows), {
    limit: async () => rows,
  });
}

describe("launch spec agent sharing access", () => {
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

  // getAgentFullConfig 对共享 Agent 按源组织解析 provider/skill/enabled MCP，而不扩展 knowledge 权限
  test("getAgentFullConfig 穿透共享 Agent 的私有依赖", async () => {
    stubResourcePermissionRepo({
      canReadExternalResource: async () => true,
      listOwnedByOrganization: async () => [],
    });
    let selectCount = 0;
    stubDb({
      select: () => ({
        from: () => ({
          where: () => {
            selectCount += 1;
            if (selectCount === 1) {
              return queryResult([
                {
                  id: "agc_external",
                  userId: "user_source",
                  organizationId: "org_source",
                  name: "shared-agent",
                  prompt: "shared prompt",
                  model: "org_source/prov_source/shared-model",
                  steps: 10,
                  mode: "primary",
                  permission: null,
                  variant: null,
                  temperature: null,
                  topP: null,
                  disable: false,
                  hidden: false,
                  color: null,
                  description: null,
                  knowledge: { knowledgeBaseIds: ["kb-private"] },
                  machineId: "machine-source",
                  createdAt: now,
                  updatedAt: now,
                },
              ]);
            }
            if (selectCount === 2) {
              return queryResult([
                {
                  id: "prov_source",
                  userId: "user_source",
                  organizationId: "org_source",
                  name: "openai",
                  displayName: "OpenAI",
                  protocol: "openai",
                  baseUrl: "https://source.example.com",
                  apiKey: "source-key",
                  extraOptions: {},
                  createdAt: now,
                  updatedAt: now,
                },
              ]);
            }
            if (selectCount === 3) {
              return queryResult([
                {
                  id: "mcp_enabled",
                  userId: "user_source",
                  organizationId: "org_source",
                  name: "external-enabled",
                  type: "remote",
                  config: { type: "remote", url: "https://mcp.example.com" },
                  enabled: true,
                  createdAt: now,
                  updatedAt: now,
                },
                {
                  id: "mcp_disabled",
                  userId: "user_source",
                  organizationId: "org_source",
                  name: "external-disabled",
                  type: "remote",
                  config: { type: "remote", url: "https://disabled.example.com" },
                  enabled: false,
                  createdAt: now,
                  updatedAt: now,
                },
              ]);
            }
            if (selectCount === 4) {
              return queryResult([{ skillId: "skill_private" }]);
            }
            return queryResult([
              {
                id: "skill_private",
                userId: "user_source",
                organizationId: "org_source",
                name: "shared-skill",
                description: "private skill",
                contentPath: "/tmp/shared-skill/SKILL.md",
                metadata: {},
                createdAt: now,
                updatedAt: now,
              },
            ]);
          },
        }),
      }),
    });

    const fullConfig = await getAgentFullConfig(ctx, "agc_external");

    expect(fullConfig.agentConfig?.organizationId).toBe("org_source");
    expect(fullConfig.providers.map((row) => row.resourceAccess?.resourceKey)).toEqual(["org_source/prov_source"]);
    expect(fullConfig.skills.map((row) => row.id)).toEqual(["skill_private"]);
    expect(fullConfig.mcpServers.map((row) => row.name)).toEqual(["external-enabled"]);
    expect(fullConfig.agentConfig?.knowledge).toEqual({ knowledgeBaseIds: ["kb-private"] });
  });

  // buildLaunchSpec 使用共享 Agent 穿透得到的 provider/skill/mcp 生成运行时配置
  test("buildLaunchSpec 使用共享 Agent 依赖生成 LaunchSpec", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
    });

    const spec = await buildLaunchSpec({
      organizationId: "org_current",
      userId: "user_owner",
      environmentId: "env_shared",
      agentName: "shared-agent",
      agentConfigId: "agc_external",
      agentPrompt: "shared prompt",
      modelRef: "org_source/prov_source/shared-model",
      environmentSecret: "secret",
      fullConfig: {
        agentConfig: null,
        providers: [
          {
            id: "prov_source",
            userId: "user_source",
            organizationId: "org_source",
            name: "openai",
            displayName: "OpenAI",
            protocol: "openai",
            baseUrl: "https://source.example.com",
            apiKey: "source-key",
            extraOptions: {},
            createdAt: now,
            updatedAt: now,
            resourceAccess: {
              ownership: "internal",
              sourceOrganizationId: "org_source",
              sourceOrganizationName: "Source Team",
              resourceUid: "prov_source",
              resourceKey: "org_source/prov_source",
              manageable: true,
              writable: true,
              publicReadable: false,
            },
          },
        ],
        skills: [],
        mcpServers: [
          {
            id: "mcp_enabled",
            userId: "user_source",
            organizationId: "org_source",
            name: "external-enabled",
            type: "remote",
            config: { type: "remote", url: "https://mcp.example.com" },
            enabled: true,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    });

    expect(spec.model).toMatchObject({
      provider: "openai",
      baseUrl: "https://source.example.com",
      apiKey: "source-key",
      model: "shared-model",
    });
    expect(spec.mcpServers).toEqual([
      {
        name: "external-enabled",
        type: "streamable-http",
        url: "https://mcp.example.com",
        headers: undefined,
        timeout: undefined,
      },
    ]);
  });

  // 当前组织 Agent 引用外部共享 provider 时，只按 modelRef 精确拉取被引用 provider
  test("getAgentFullConfig 按 modelRef 精确拉取外部 provider", async () => {
    let selectCount = 0;
    stubResourcePermissionRepo({
      listOwnedByOrganization: async () => [],
    });
    stubDb({
      select: () => ({
        from: () => ({
          where: () => {
            selectCount += 1;
            if (selectCount === 1) {
              return queryResult([
                {
                  id: "agc_internal",
                  userId: "user_owner",
                  organizationId: "org_current",
                  name: "internal-agent",
                  prompt: null,
                  model: "org_source/prov_source/shared-model",
                  steps: 10,
                  mode: "primary",
                  permission: null,
                  variant: null,
                  temperature: null,
                  topP: null,
                  disable: false,
                  hidden: false,
                  color: null,
                  description: null,
                  knowledge: null,
                  machineId: null,
                  createdAt: now,
                  updatedAt: now,
                },
              ]);
            }
            if (selectCount === 2) {
              return queryResult([
                {
                  id: "prov_source",
                  userId: "user_source",
                  organizationId: "org_source",
                  name: "ali",
                  displayName: "Ali",
                  protocol: "anthropic",
                  baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic/v1",
                  apiKey: "source-key",
                  extraOptions: {},
                  createdAt: now,
                  updatedAt: now,
                },
              ]);
            }
            if (selectCount === 3) return queryResult([]);
            return queryResult([]);
          },
        }),
      }),
    });

    const fullConfig = await getAgentFullConfig(ctx, "agc_internal");

    expect(fullConfig.providers.map((row) => row.id)).toEqual(["prov_source"]);
    expect(fullConfig.providers.find((row) => row.id === "prov_source")).toMatchObject({
      organizationId: "org_source",
      apiKey: "source-key",
    });
  });
});
