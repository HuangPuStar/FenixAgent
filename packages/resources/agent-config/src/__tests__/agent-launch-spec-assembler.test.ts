import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createModelService } from "@fenix/model-management/server";
import { createStubModelRepository, createStubProviderRepository } from "@fenix/model-management/server/testing";
import { AppError, NotFoundError } from "@fenix/platform-sdk";
import { createStubMcpServerService } from "@fenix/resource-mcp/server/testing";
import { createSkillModuleConfig, createStubSkillService } from "@fenix/resource-skill/server/testing";
import { createAgentLaunchSpecAssembler } from "../server/services/agent-launch-spec";
import { createStubAgentAssociations, initializeAgentConfigModuleConfig } from "../server/testing";
import {
  installAgentModuleStub,
  launchSpecDeps,
  mcpRow,
  modelRow,
  providerRow,
  resetAgentModuleStub,
  scopedAgent,
} from "./fixtures";

/**
 * 启动参数组装（`agent-launch-spec/`）的用例。
 *
 * 覆盖面刻意收在「组装器自己的编排」上：可见性入口、知识点注入、额外变量优先级、最小启动路径，以及
 * 调用方身份（组织 / 用户）在并发下不被串用。三个解析模块（model / mcp / memory-env）的规则由同目录的
 * `agent-launch-spec-*.test.ts` 逐条覆盖，这里用替身顶替它们，只钉住它们被怎样串起来。
 *
 * 迁移说明（W4b）：本文件的前身是 `agent-runtime` 的 12 个 `launch-spec-builder` 用例。按断言面改写后，
 * 规则类断言落到同目录的三个 `agent-launch-spec-*.test.ts`，编排类断言留在这里。
 */

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
      createAgentLaunchSpecAssembler(launchSpecDeps()).buildAgentLaunchSpec({
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
    const deps = launchSpecDeps({
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
    const deps = launchSpecDeps({
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
    const deps = launchSpecDeps({
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

  // 环境 ID 是可选字段：不传时字段整体不出现，而不是留空串——下游按字段是否存在区分「无环境」与
  // 「环境 ID 为空」，空串会让两者混在一起。
  test("未指定环境 ID 时省略该字段", async () => {
    stubVisibleAgentConfig();

    const spec = await createAgentLaunchSpecAssembler(launchSpecDeps()).buildAgentLaunchSpec({
      organizationId: "org-1",
      userId: "user-1",
      agentConfigId: "agent-1",
      environmentSecret: "env-secret",
    });

    expect(spec.environmentId).toBeUndefined();
    expect("environmentId" in spec).toBe(false);
  });

  // 并发组装：启动参数按调用方身份（组织 / 用户）隔离，共享的只读 deps 不得让结果互相串用。
  test("并发组装保持调用方身份隔离", async () => {
    stubVisibleAgentConfig();
    const assembler = createAgentLaunchSpecAssembler(launchSpecDeps());

    const specs = await Promise.all(
      ["org-a", "org-b", "org-c", "org-d"].map((organizationId) =>
        assembler.buildAgentLaunchSpec({
          organizationId,
          userId: `user-of-${organizationId}`,
          environmentId: `env-of-${organizationId}`,
          agentConfigId: "agent-1",
          environmentSecret: "env-secret",
        }),
      ),
    );

    expect(specs.map((spec) => spec.organizationId)).toEqual(["org-a", "org-b", "org-c", "org-d"]);
    expect(specs.map((spec) => spec.userId)).toEqual([
      "user-of-org-a",
      "user-of-org-b",
      "user-of-org-c",
      "user-of-org-d",
    ]);
    expect(specs.map((spec) => spec.environmentId)).toEqual([
      "env-of-org-a",
      "env-of-org-b",
      "env-of-org-c",
      "env-of-org-d",
    ]);
    expect(specs.every((spec) => spec.model.apiKey === "resolved-key")).toBe(true);
  });
});

describe("最小启动参数（无 AgentConfig 绑定）", () => {
  beforeEach(() => {
    initializeAgentConfigModuleConfig({}, { memory: {} });
  });

  // 组织内一个模型都没配置时直接失败并引导先配置模型：这是最小路径唯一的失败前提。
  test("组织内无可用模型时抛 INVALID_CONFIG", async () => {
    const deps = launchSpecDeps({
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
    const deps = launchSpecDeps({
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
