# @fenix-ce/agent-config

CE 的完整 AgentConfig 资源领域模块；后端、schema、数据迁移和 web contribution 物理就近。

目录职责：

- `domain/`：AgentConfig、输入 DTO 与不依赖授权的字段规则。
- `services/`：`AgentConfigFacade` 处理 CRUD、visibility 更新、`ResourceQueryConstraint`、`use` 授权和启动参数解析；`AgentConfigRunFacade` 通过 `AgentInstanceStarter` 端口启动实例。
- `repositories/`：repository 实现；demo 使用内存实现，生产版本由平台 `AuthorizedResourceQuery` 将范围过滤编译为数据库 `WHERE`。
- `routes/`：`/app` route contribution，只负责 HTTP 协议适配。
- `module.ts`：该资源的 schema、迁移、API、控制台和 capability 声明。
- `db/`：`agent_configs` 主表 schema 和数据迁移示例。
- `web/`：浏览器专用 `./web` 公开子路径；demo 提供空页面 contribution。

允许依赖：`@fenix-ce/platform-sdk`。

禁止放入：Instance 生命周期和实例权限、EE 发布字段/审批逻辑、CE 组织角色细节。routes 不导入 `./web`；web 不导入 service、repository、db 或 adapters 内部实现。InstanceManager 只消费本包输出的已授权启动参数；它不接收 actor。
