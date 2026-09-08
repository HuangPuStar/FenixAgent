/**
 * Drizzle 伪 schema：资源身份/归属与 AgentConfig 属性分表。
 *
 * 真实项目会在这里使用 pgTable/mysqlTable；demo 用文本保留迁移边界，避免引入 Drizzle 依赖。
 */
export const agentConfigSchema = {
  resources: "resources(id, type, ownership_scope_kind, ownership_scope_id, created_at, created_by)",
  properties: "agent_config_properties(resource_id FK resources.id, name, normalized_name, engine)",
  grants: "resource_access_grants(resource_id FK resources.id, grantee, action, expires_at)",
};
