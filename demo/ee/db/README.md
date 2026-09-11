# db

EE 的统一 DDL migration 链。发布顺序始终为 CE chain → EE chain → EE 模块数据迁移。

EE migration 不能修改 CE 表；商业字段使用扩展表并以 `agent_config_id` 关联 CE `agent_configs`。
