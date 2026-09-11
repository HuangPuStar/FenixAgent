-- Drizzle 伪迁移：EE 自己的 DDL 链，只创建 EE 拥有的表。
CREATE TABLE agent_config_publications (... agent_config_id REFERENCES agent_configs(id) ...);
