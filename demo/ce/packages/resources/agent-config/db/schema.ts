/**
 * Drizzle 伪 schema：AgentConfig 主表固定归属列与业务字段。
 *
 * 真实项目会在这里使用 pgTable/mysqlTable；demo 用文本保留迁移边界，避免引入 Drizzle 依赖。
 */
export const agentConfigSchema = {
  agentConfigs:
    "agent_configs(id, organization_id, user_id, visibility, name, normalized_name, engine, created_at, created_by)",
};
