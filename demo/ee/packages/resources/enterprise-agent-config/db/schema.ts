/** EE 只拥有发布扩展表；通过 agent_config_id 引用 CE agent_configs 主表，不修改 CE 表。 */
export const enterpriseAgentConfigSchema = {
  publications: "agent_config_publications(agent_config_id FK agent_configs.id, status, published_at)",
};
