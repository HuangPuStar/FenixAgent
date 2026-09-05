/** EE 只拥有发布扩展表；通过 resource_id 引用 CE resources 基表，不修改 CE 表。 */
export const enterpriseAgentConfigSchema = {
  publications: "agent_config_publications(resource_id FK resources.id, status, published_at)",
};
