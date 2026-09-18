# CE / EE 工程架构设计索引

本文是工程设计的**母文档**，仅标明两个子文档的职责，不重复设计条款，也不包含迁移任务或实施步骤。

| 子文档 | 只说明 | 使用范围 |
| --- | --- | --- |
| [仓库目录结构与归属说明](./ce-ee-engineering-directory-structure.md) | `apps/`、`packages/`、`db/`、`deploy/` 等目录及模块文件的物理 owner | 核查模块与文件归属 |
| [目标架构与开发规范](./ce-ee-engineering-standards.md) | 模块接口、依赖、装配、权限、协议、前端、DB、部署与最终一致性验收等长期规范 | 工程适配、架构核查与验收的目标依据 |

[EE 扩展架构](./ee-extension-architecture.md) 仅用于 EE 和客户化扩展的设计，不属于 CE 重构输入。
