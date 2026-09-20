import { log } from "@fenix/logger";
import { NotFoundError } from "@fenix/platform-sdk";
import type { AgentLaunchSpec, McpServerConfig } from "@fenix/plugin-sdk";
import { getAgentConfigVisibleToUser } from "../../system-entries";
import { composeAgentSystemPrompt } from "../agent-system-prompt";
import { buildMcpSpecs, loadAgentMcpServers } from "./mcp-resolution";
import { buildLangfuseEnv, buildMemoryLaunchEnv } from "./memory-env";
import { resolveFirstConfiguredModel, resolveModelConfig } from "./model-resolution";
import { buildSkillSpecs, loadAgentSkills } from "./skill-resolution";
import { LAUNCH_SPEC_LOG_PREFIX, summarizeLaunchMcpServers, summarizeRawMcpServers, summarizeSkills } from "./support";
import type {
  AgentLaunchSpecAssembler,
  AgentLaunchSpecAssemblerDeps,
  BuildAgentLaunchSpecInput,
  BuildMinimalLaunchSpecInput,
} from "./types";

/**
 * 启动参数组装：从 Agent 配置向外解析模型、Skill、MCP、知识库与记忆，产出 core 可直接消费的
 * `AgentLaunchSpec`。
 *
 * 设计约束（迁移前既有约定，保持不变）：
 * 1. 组装层自己取数，不做半成品聚合层再筛选一遍；
 * 2. 不做权限判断——可见性由 {@link getAgentConfigVisibleToUser} 在入口处一次性判定；
 * 3. 不做 fallback，任何关键资源缺失都直接失败，避免实例"看起来启动成功"但工具集残缺。
 */

/** 知识库绑定的保留 MCP 入口：不是普通 mcpServer 行，而是平台按环境密钥注入的通道。 */
const KNOWLEDGE_MCP_NAME = "kb";

/** 无 AgentConfig 的最小启动路径使用的 Agent 名（既有取值，前端按此识别 "build" 实例）。 */
const MINIMAL_AGENT_NAME = "build";

/**
 * 按 Agent 配置组装完整启动参数。
 *
 * 可见性判定在**组装器内部**完成，调用方只给出 `organizationId` + `userId` + `agentConfigId`：
 * 迁移前由调用方先取行再传入，调用方为了造出一个 actor 会伪造 `role:"owner"`（review §9.1）；
 * 判定收进本包后，调用方既不需要、也无法伪造权限结论。
 */
export async function buildAgentLaunchSpec(
  deps: AgentLaunchSpecAssemblerDeps,
  input: BuildAgentLaunchSpecInput,
): Promise<AgentLaunchSpec> {
  const { organizationId, userId, environmentId, agentConfigId, environmentSecret } = input;
  const agentConfig = await getAgentConfigVisibleToUser({ agentConfigId, organizationId, userId });
  if (!agentConfig) {
    throw new NotFoundError(`AgentConfig '${agentConfigId}' not found`);
  }

  log(
    `${LAUNCH_SPEC_LOG_PREFIX} buildAgentLaunchSpec: agent='${agentConfig.name}', agentConfigId='${agentConfig.id}', modelId='${agentConfig.modelId ?? ""}', org='${agentConfig.organizationId}'`,
  );

  // Phase 1: 先并行拿到构造 launchSpec 的原始资源，确保错误尽早暴露。
  const [model, skillRows, rawMcpServers, knowledgeBindings] = await Promise.all([
    resolveModelConfig(deps, agentConfig, userId),
    loadAgentSkills(deps, agentConfig),
    loadAgentMcpServers(deps, agentConfig),
    deps.associations.listKnowledgeBindings(agentConfig.id),
  ]);

  log(
    `${LAUNCH_SPEC_LOG_PREFIX} buildAgentLaunchSpec: loaded skills=${JSON.stringify(summarizeSkills(skillRows))}, raw mcpServers=${JSON.stringify(summarizeRawMcpServers(rawMcpServers))}`,
  );
  log(
    `${LAUNCH_SPEC_LOG_PREFIX} buildAgentLaunchSpec: resolved model provider='${model.provider}', model='${model.model}', modelName='${model.modelName ?? ""}', baseUrl='${model.baseUrl}', hasApiKey=${Boolean(model.apiKey)}`,
  );

  // Phase 2: 把数据库配置翻译成 runtime 真正消费的结构。
  const mcpServers: McpServerConfig[] = buildMcpSpecs(rawMcpServers, agentConfig.id);
  const skills = await buildSkillSpecs(agentConfig, skillRows);

  // 知识库绑定不是普通 mcpServer 行，而是平台注入的保留 MCP 入口：地址指向本服务，鉴权用环境密钥
  // （环境密钥只在同进程内传递，不落盘、不入日志）。
  if (knowledgeBindings.length > 0) {
    mcpServers.push({
      name: KNOWLEDGE_MCP_NAME,
      type: "streamable-http",
      url: `${deps.env.baseUrl}/mcp/knowledge`,
      headers: { Authorization: `Bearer ${environmentSecret}` },
      timeout: 15000,
    });
    log(
      `${LAUNCH_SPEC_LOG_PREFIX} buildAgentLaunchSpec: appended knowledge mcp for ${knowledgeBindings.length} bindings`,
    );
  }

  log(
    `${LAUNCH_SPEC_LOG_PREFIX} buildAgentLaunchSpec: final skills=${JSON.stringify(skills)}, final mcpServers=${JSON.stringify(summarizeLaunchMcpServers(mcpServers))}`,
  );
  const finalPrompt = composeAgentSystemPrompt(deps.env.agentSystemPrompt, agentConfig.name, agentConfig.prompt);

  // Phase 3: 记忆与观测的环境变量按「调用方显式传入优先」的次序合并，产出最终 launchSpec。
  const memory = await buildMemoryLaunchEnv(deps, {
    agentConfigId: agentConfig.id,
    organizationId,
    userId,
    extra: (agentConfig.extra as Record<string, unknown> | null | undefined) ?? null,
  });
  const launchEnv = { ...memory.env, ...buildLangfuseEnv(deps), ...(input.extraEnv ?? {}) };

  return {
    organizationId,
    userId,
    ...(environmentId ? { environmentId } : {}),
    env: launchEnv,
    agent: {
      name: agentConfig.name,
      prompt: finalPrompt,
      ...(memory.extra ? { extra: memory.extra } : {}),
    },
    model,
    skills,
    mcpServers,
  };
}

/**
 * 构造一个不依赖 AgentConfig 的最小 LaunchSpec：第一个可用模型 + 空资源集。
 *
 * 哪些环境允许走这条路径由调用方决定（见 `agent-runtime` 的启动分支）；这里只负责产出一个能跑起来
 * 的最小配置，一个可用模型都没有时直接失败并提示先配置模型。
 */
export async function buildMinimalLaunchSpec(
  deps: AgentLaunchSpecAssemblerDeps,
  input: BuildMinimalLaunchSpecInput,
): Promise<AgentLaunchSpec> {
  const modelConfig = await resolveFirstConfiguredModel(deps, {
    organizationId: input.organizationId,
    userId: input.userId,
    environmentId: input.environmentId,
  });
  log(
    `${LAUNCH_SPEC_LOG_PREFIX} buildMinimalLaunchSpec: org='${input.organizationId}', user='${input.userId}', environmentId='${input.environmentId ?? ""}', provider='${modelConfig.provider}', model='${modelConfig.model}'`,
  );

  return {
    organizationId: input.organizationId,
    userId: input.userId,
    ...(input.environmentId ? { environmentId: input.environmentId } : {}),
    env: { ...buildLangfuseEnv(deps), ...(input.extraEnv ?? {}) },
    agent: {
      name: MINIMAL_AGENT_NAME,
      prompt: composeAgentSystemPrompt(deps.env.agentSystemPrompt, MINIMAL_AGENT_NAME),
    },
    model: modelConfig,
    skills: [],
    mcpServers: [],
  };
}

/** 组装器工厂：宿主在装配阶段构造一次，把 deps 收进闭包后绑定到 `AgentLaunchSpecPort`。 */
export function createAgentLaunchSpecAssembler(deps: AgentLaunchSpecAssemblerDeps): AgentLaunchSpecAssembler {
  return {
    buildAgentLaunchSpec: (input) => buildAgentLaunchSpec(deps, input),
    buildMinimalLaunchSpec: (input) => buildMinimalLaunchSpec(deps, input),
  };
}
