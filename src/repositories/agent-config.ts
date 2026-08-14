import { type AgentConfigData, type AgentConfigRepo, LaunchSpecBuildError } from "@fenix/orchestration";
import { and, eq } from "drizzle-orm";
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
