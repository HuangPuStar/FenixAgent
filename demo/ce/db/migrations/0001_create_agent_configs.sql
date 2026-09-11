-- Drizzle 伪迁移：AgentConfig 主表直接承载固定归属列与业务字段。
CREATE TABLE agent_configs (... organization_id, user_id, visibility, name, normalized_name, engine ...);
