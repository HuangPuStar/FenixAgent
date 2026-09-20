import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createModelService } from "@fenix/model-management/server";
import { createStubModelRepository, createStubProviderRepository } from "@fenix/model-management/server/testing";
import { AppError, NotFoundError } from "@fenix/platform-sdk";
import type { McpServerRow } from "@fenix/resource-mcp/server";
import { createStubMcpServerService } from "@fenix/resource-mcp/server/testing";
import { createSkillModuleConfig, createStubSkillService } from "@fenix/resource-skill/server/testing";
import {
  type AgentLaunchSpecAssemblerDeps,
  createAgentLaunchSpecAssembler,
} from "../server/services/agent-launch-spec";
import { createStubAgentAssociations, initializeAgentConfigModuleConfig } from "../server/testing";
import { FIXTURE_NOW, installAgentModuleStub, resetAgentModuleStub, scopedAgent } from "./fixtures";

/**
 * 启动参数组装（`agent-launch-spec/`）的用例。
 *
 * 覆盖面刻意收在「本模块自己新增的编排」上：可见性入口、知识点注入、额外变量优先级、以及在运行期
 * 环境的两个投递面之外的失败语义。各资源侧的行读取规则由对应资源包的用例覆盖，这里用替身顶替。
 *
 * 迁移期说明（W4a）：`agent-runtime` 的 12 个旧用例此刻仍指向旧实现（`launch-spec-builder.ts`），
 * 按断言面改写它们的交付在 W4b 完成；本文件不复制那批断言。
 */

function mcpRow(overrides: Partial<McpServerRow> = {}): McpServerRow {
  return {
    id: "mcp-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "filesystem",
    type: "stdio",
    config: { type: "stdio", command: "npx", args: ["-y", "fs-mcp"] },
    enabled: true,
    visibility: "private",
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

function modelRow() {
  return {
    id: "model-1",
    providerId: "provider-1",
    organizationId: "org-1",
    modelId: "gpt-4o",
    displayName: "GPT-4o",
    modalities: null,
    limitConfig: null,
    cost: null,
    options: null,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
  };
}

function providerRow() {
  return {
    id: "provider-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "openai",
    displayName: "OpenAI",
    kind: "direct" as const,
    gatewayType: null,
    protocol: "openai" as const,
    baseUrl: "https://api.example.com",
    apiKey: "{env:PROVIDER_KEY}",
    extraOptions: null,
    visibility: "private",
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
  };
}

/** 组装依赖替身：默认一个已绑定 Provider 的模型、无 skill / MCP / 知识库绑定。 */
function buildDeps(overrides: Partial<AgentLaunchSpecAssemblerDeps> = {}): AgentLaunchSpecAssemblerDeps {
  return {
    associations: createStubAgentAssociations(),
    skills: createStubSkillService(),
    mcp: createStubMcpServerService(),
    models: createModelService({
      modelRepository: createStubModelRepository({ findRowUnscoped: async () => modelRow() }),
      providerRepository: createStubProviderRepository({
        findRowByOrganizationUnscoped: async () => providerRow(),
      }),
    }),
    env: {
      agentSystemPrompt: "你当前的 Agent 名称是「{{agentName}}」。",
      baseUrl: "https://platform.example.com",
      langfuse: { publicKey: "pk-1", secretKey: "sk-1", baseUrl: "https://lf.example.com" },
    },
    resolveProviderApiKey: (raw) => (raw === "{env:PROVIDER_KEY}" ? "resolved-key" : raw),
    ...overrides,
  };
}

/** 让组织范围读入口返回给定配置行；`undefined` 表示该用户读不到这个配置。 */
function stubVisibleAgentConfig(row = scopedAgent({ modelId: "model-1" })): void {
  installAgentModuleStub({
    identity: { listMemberships: async () => [{ organizationId: "org-1", role: "owner" }] },
    facade: { findReadableRowById: async () => row },
  });
}

/** 捕获组装抛出的错误；不用 `rejects.toThrow` 是为了同时断言错误码。 */
async function captureError(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("预期组装失败，但调用成功返回");
}

describe("AgentLaunchSpec 组装", () => {
  beforeEach(() => {
    // 组装会读另外两个模块的配置：Hindsight 地址（`getHindsightConfig()`）与 skill 根目录
    // （`getGlobalSkillsDir()`，无绑定 skill 时也会读）。未装配即抛错，故一次传齐。
    initializeAgentConfigModuleConfig({}, { memory: {}, skill: createSkillModuleConfig() });
  });

  afterEach(() => resetAgentModuleStub());

  // 配置对该用户不可见时按"不存在"失败：可见性判定在组装器内完成，调用方无从伪造主体。
  test("配置不可见时抛 NotFoundError", async () => {
    installAgentModuleStub({
      identity: { listMemberships: async () => [] },
      facade: { findReadableRowById: async () => undefined },
    });

    const error = await captureError(() =>
      createAgentLaunchSpecAssembler(buildDeps()).buildAgentLaunchSpec({
        organizationId: "org-1",
        userId: "user-1",
        agentConfigId: "agent-1",
        environmentSecret: "env-secret",
      }),
    );

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toBe("AgentConfig 'agent-1' not found");
  });

  // 知识点绑定注入平台保留 MCP 入口（地址指向本服务、Bearer 环境密钥），并要求 extraEnv 覆盖同名变量。
  test("注入知识库 MCP 入口并按 extraEnv 覆盖同名环境变量", async () => {
    stubVisibleAgentConfig();
    const deps = buildDeps({
      associations: createStubAgentAssociations({
        listMcpIds: async () => ["mcp-1"],
        listKnowledgeBindings: async () => [{ knowledgeBaseId: "kb-1" }],
      }),
      mcp: createStubMcpServerService({ listRowsByIdsUnscoped: async () => [mcpRow()] }),
    });

    const spec = await createAgentLaunchSpecAssembler(deps).buildAgentLaunchSpec({
      organizationId: "org-1",
      userId: "user-1",
      environmentId: "env-1",
      agentConfigId: "agent-1",
      environmentSecret: "env-secret",
      extraEnv: { LANGFUSE_BASE_URL: "https://override.example.com" },
    });

    expect(spec.mcpServers).toEqual([
      { name: "filesystem", type: "stdio", command: "npx", args: ["-y", "fs-mcp"], env: undefined, timeout: undefined },
      {
        name: "kb",
        type: "streamable-http",
        url: "https://platform.example.com/mcp/knowledge",
        headers: { Authorization: "Bearer env-secret" },
        timeout: 15000,
      },
    ]);
    // Provider 行的 `{env:VAR}` 由宿主注入的解析器解引用；没解析到就是空串，绝不把引用式原样下发。
    expect(spec.model.apiKey).toBe("resolved-key");
    expect(spec.env).toEqual({
      LANGFUSE_PUBLIC_KEY: "pk-1",
      LANGFUSE_SECRET_KEY: "sk-1",
      // 调用方显式传入的同名变量优先于宿主配置
      LANGFUSE_BASE_URL: "https://override.example.com",
    });
    expect(spec.agent.name).toBe("demo-agent");
    expect(spec.agent.prompt).toBe("你当前的 Agent 名称是「demo-agent」。");
    expect(spec.skills).toEqual([]);
  });

  // 绑定存在但 skill 行缺失属于配置损坏：直接失败，不让实例带着残缺的工具集"看起来启动成功"。
  test("skill 绑定指向缺失行时抛 INVALID_CONFIG", async () => {
    stubVisibleAgentConfig();
    const deps = buildDeps({
      associations: createStubAgentAssociations({ listSkillIds: async () => ["skill-missing"] }),
      skills: createStubSkillService({ listRowsByIdsUnscoped: async () => [] }),
    });

    const error = await captureError(() =>
      createAgentLaunchSpecAssembler(deps).buildAgentLaunchSpec({
        organizationId: "org-1",
        userId: "user-1",
        agentConfigId: "agent-1",
        environmentSecret: "env-secret",
      }),
    );

    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain("references missing skills");
  });

  // 绑定了已停用的 MCP 同样按配置损坏处理，错误文案要能区分"缺行"与"停用"两种状态。
  test("绑定已停用的 MCP 时抛 INVALID_CONFIG", async () => {
    stubVisibleAgentConfig();
    const deps = buildDeps({
      associations: createStubAgentAssociations({ listMcpIds: async () => ["mcp-1"] }),
      mcp: createStubMcpServerService({ listRowsByIdsUnscoped: async () => [mcpRow({ enabled: false })] }),
    });

    const error = await captureError(() =>
      createAgentLaunchSpecAssembler(deps).buildAgentLaunchSpec({
        organizationId: "org-1",
        userId: "user-1",
        agentConfigId: "agent-1",
        environmentSecret: "env-secret",
      }),
    );

    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain("references disabled MCP servers");
  });
});

describe("最小启动参数（无 AgentConfig 绑定）", () => {
  beforeEach(() => {
    initializeAgentConfigModuleConfig({}, { memory: {} });
  });

  // 组织内一个模型都没配置时直接失败并引导先配置模型：这是最小路径唯一的失败前提。
  test("组织内无可用模型时抛 INVALID_CONFIG", async () => {
    const deps = buildDeps({
      models: createModelService({
        modelRepository: createStubModelRepository(),
        providerRepository: createStubProviderRepository({ listByOrganizationUnscoped: async () => [] }),
      }),
    });

    const error = await captureError(() =>
      createAgentLaunchSpecAssembler(deps).buildMinimalLaunchSpec({
        organizationId: "org-1",
        userId: "user-1",
        environmentId: "env-1",
      }),
    );

    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain("requires at least one configured model");
  });

  // 最小路径不继承任何 prompt / skill / MCP，agent 名固定为 build（前端据此识别最小实例）。
  test("空资源集与 build 名称，仅注入观测变量", async () => {
    const deps = buildDeps({
      models: createModelService({
        modelRepository: createStubModelRepository({
          findFirstByProviderUnscoped: async () => modelRow(),
        }),
        providerRepository: createStubProviderRepository({
          listByOrganizationUnscoped: async () => [providerRow()],
        }),
      }),
    });

    const spec = await createAgentLaunchSpecAssembler(deps).buildMinimalLaunchSpec({
      organizationId: "org-1",
      userId: "user-1",
      environmentId: "env-1",
      extraEnv: { USER_META_USER_ID: "user-1" },
    });

    expect(spec.agent).toEqual({ name: "build", prompt: "你当前的 Agent 名称是「build」。" });
    expect(spec.skills).toEqual([]);
    expect(spec.mcpServers).toEqual([]);
    expect(spec.model).toMatchObject({ provider: "openai", model: "gpt-4o", apiKey: "resolved-key" });
    expect(spec.env).toEqual({
      LANGFUSE_PUBLIC_KEY: "pk-1",
      LANGFUSE_SECRET_KEY: "sk-1",
      LANGFUSE_BASE_URL: "https://lf.example.com",
      USER_META_USER_ID: "user-1",
    });
    expect(spec.environmentId).toBe("env-1");
  });
});
