import { type AgentConfigData, type AgentConfigRepo, LaunchSpecBuildError } from "@fenix/orchestration";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  agentConfig,
  agentConfigMcp,
  agentConfigSkill,
  agentKnowledgeBinding,
  knowledgeBase,
  mcpServer,
  model,
  provider,
  skill,
} from "../db/schema";

/**
 * 编排域 AgentConfigRepo 的 PostgreSQL 实现。
 *
 * 供 LaunchSpecBuilder 消费：一次 JOIN 查询返回扁平聚合配置（skills / mcpServers /
 * knowledgeBases 已内嵌），避免编排域感知 DB 关联结构。
 */
export class PgAgentConfigRepo implements AgentConfigRepo {
  /**
   * 按配置 ID 读取扁平聚合配置。
   *
   * - `agent_config` 记录不存在时返回 `null`；
   * - `modelId` 为 null 或引用的 model/provider 行缺失时抛错：这是配置引用损坏
   *   （运行时只认正式的 modelId 外键），静默降级会让 Agent 在缺模型时“伪成功”启动，
   *   与旧 launch-spec-builder 的阻断策略保持一致，message 携带诊断上下文。
   */
  async getConfig(configId: string): Promise<AgentConfigData | null> {
    const rows = await db
      .select({
        configId: agentConfig.id,
        configName: agentConfig.name,
        systemPrompt: agentConfig.prompt,
        engineType: agentConfig.engineType,
        modelName: model.modelId,
        providerName: provider.name,
        skillId: agentConfigSkill.skillId,
        skillName: skill.name,
        mcpServerId: agentConfigMcp.mcpServerId,
        mcpServerName: mcpServer.name,
        kbId: agentKnowledgeBinding.knowledgeBaseId,
        kbName: knowledgeBase.name,
      })
      .from(agentConfig)
      .leftJoin(model, eq(agentConfig.modelId, model.id))
      .leftJoin(provider, eq(model.providerId, provider.id))
      .leftJoin(agentConfigSkill, eq(agentConfigSkill.agentConfigId, agentConfig.id))
      .leftJoin(skill, eq(agentConfigSkill.skillId, skill.id))
      .leftJoin(agentConfigMcp, eq(agentConfigMcp.agentConfigId, agentConfig.id))
      .leftJoin(mcpServer, eq(agentConfigMcp.mcpServerId, mcpServer.id))
      // 只取启用的知识库绑定：与 repositories/knowledge-base.ts 的
      // getKnowledgeBasesByAgentConfigId 行为一致，禁用的 KB 不应进入 LaunchSpec。
      .leftJoin(
        agentKnowledgeBinding,
        and(eq(agentKnowledgeBinding.agentConfigId, agentConfig.id), eq(agentKnowledgeBinding.enabled, true)),
      )
      .leftJoin(knowledgeBase, eq(agentKnowledgeBinding.knowledgeBaseId, knowledgeBase.id))
      .where(eq(agentConfig.id, configId));

    if (rows.length === 0) return null;

    const first = rows[0];
    // model 引用缺失（modelId 为空或 FK 断裂）属配置损坏，阻断启动而非静默降级。
    // 抛编排域 LaunchSpecBuildError（而非裸 Error）：错误携带稳定 code，宿主
    // error-handler 可按 code 分类映射 HTTP 状态。
    if (first.modelName === null || first.providerName === null) {
      throw new LaunchSpecBuildError(
        `agentConfig '${first.configId}' references missing model (modelId resolved to null model/provider row)`,
      );
    }

    // 多对多关联与 model/provider 之间是笛卡尔积展开，同一 skill/mcp/kb 会重复出现，
    // 按主键去重后保持插入顺序。
    const skills = new Map<string, string>();
    const mcpServers = new Map<string, string>();
    const knowledgeBases = new Map<string, string>();
    for (const row of rows) {
      if (row.skillId !== null && row.skillName !== null) skills.set(row.skillId, row.skillName);
      if (row.mcpServerId !== null && row.mcpServerName !== null) mcpServers.set(row.mcpServerId, row.mcpServerName);
      if (row.kbId !== null && row.kbName !== null) knowledgeBases.set(row.kbId, row.kbName);
    }

    return {
      id: first.configId,
      name: first.configName,
      systemPrompt: first.systemPrompt,
      // engine_type 列允许为空（未声明 notNull），DB 默认 'opencode'，此处与默认值对齐，
      // 避免空引擎引用把启动流程带偏。
      engineId: first.engineType ?? "opencode",
      // 字段名带 Id，但语义与旧 launch-spec-builder 的 ModelConfig.provider 对齐：
      // 存 provider 名称（如 "openviking"），运行时插件以名称作为密钥/路由标识。
      modelProviderId: first.providerName,
      modelName: first.modelName,
      skills: [...skills].map(([skillId, name]) => ({ skillId, name })),
      mcpServers: [...mcpServers].map(([mcpServerId, name]) => ({ mcpServerId, name })),
      knowledgeBases: [...knowledgeBases].map(([kbId, name]) => ({ kbId, name })),
    };
  }
}

/** 编排域 AgentConfigRepo 单例。 */
export const agentConfigRepo = new PgAgentConfigRepo();

// ────────────────────────────────────────────
// 运行时模型切换（设计 §5）查询
// ────────────────────────────────────────────

/** 模型预选查询结果行（modelId=引擎标识，displayName=展示名） */
export interface AgentModelPresetRow {
  id: string;
  /** 引擎模型标识（model.modelId，与 availableModels 的 value 一致） */
  modelId: string;
  /** 展示名（displayName，可为 null 时回退 modelId） */
  displayName: string | null;
}

/** 读取 agent_config 的模型预选配置（modelIds 预选列表 + modelId 默认模型 UUID） */
export async function getAgentModelPreset(
  configId: string,
): Promise<{ modelIds: string[] | null; modelId: string | null } | null> {
  const rows = await db
    .select({ modelIds: agentConfig.modelIds, modelId: agentConfig.modelId })
    .from(agentConfig)
    .where(eq(agentConfig.id, configId))
    .limit(1);
  if (rows.length === 0) return null;
  return { modelIds: rows[0].modelIds ?? null, modelId: rows[0].modelId };
}

/** 按 UUID 批量读取模型行（含引擎标识与展示名；provider 归属由调用方上下文决定） */
export async function getModelPresetRowsByIds(ids: string[]): Promise<AgentModelPresetRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: model.id, modelId: model.modelId, displayName: model.displayName })
    .from(model)
    .where(inArray(model.id, ids));
  return rows;
}

/** 按引擎标识反查模型行（model.modelId 非全局唯一，跨 provider 可能重复，返回全部） */
export async function findModelPresetRowsByEngineId(engineModelId: string): Promise<AgentModelPresetRow[]> {
  const rows = await db
    .select({ id: model.id, modelId: model.modelId, displayName: model.displayName })
    .from(model)
    .where(eq(model.modelId, engineModelId));
  return rows;
}

/** 按 provider 集合读取模型 ID（agents 路由解析预选模型白名单用；空集合直接返回空） */
export async function listModelIdsByProviderIds(providerIds: string[]): Promise<string[]> {
  if (providerIds.length === 0) return [];
  const rows = await db.select({ id: model.id }).from(model).where(inArray(model.providerId, providerIds));
  return rows.map((row) => row.id);
}

/**
 * 按 provider 集合 + 引擎标识读取模型行（专家默认模型业务标识解析用）。
 * 业务标识格式为 providerName/modelId：provider 先按 name/displayName 匹配，
 * 再在该 provider 下按 model.modelId（引擎标识）匹配。
 */
export async function findModelsByProviderIdsAndEngineId(
  providerIds: string[],
  engineModelId: string,
): Promise<AgentModelPresetRow[]> {
  if (providerIds.length === 0) return [];
  const rows = await db
    .select({ id: model.id, modelId: model.modelId, displayName: model.displayName })
    .from(model)
    .where(and(inArray(model.providerId, providerIds), eq(model.modelId, engineModelId)));
  return rows;
}
