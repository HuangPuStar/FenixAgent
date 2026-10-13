# 系统架构开发指引

本文是系统架构开发文档的入口，仅说明各文档职责，不重复规范条款。

| 子文档 | 只说明 | 使用范围 |
| --- | --- | --- |
| [目录结构与归属说明](./directory-structure.md) | `apps/`、`packages/`、`db/`、`deploy/`、`docker/` 等目录及模块文件的物理 owner | 核查模块与文件归属 |
| [工程架构与开发规范](./engineering-standards.md) | 模块接口、依赖、装配、权限、协议、前端、DB、部署与最终一致性验收等长期规范 | 工程适配、架构核查与验收的依据 |

[Access Control 开发指引](./access-control.md)、[边界豁免与依赖残留](./boundary-exemptions.md)、[工程债务](./engineering-debt.md) 与 [EE 扩展架构](./ee-extension-architecture.md) 分别说明对应开发约束。
