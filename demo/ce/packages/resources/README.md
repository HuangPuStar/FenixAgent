# resources

CE 的资源领域层，按资源聚合 DTO、领域服务、repository、基础 API/控制台贡献和模块声明。

当前子包：

- `agent-config`：AgentConfig 基础 CRUD、范围过滤查询和 `use` 授权入口。

允许依赖：`platform/` 的稳定契约。

禁止依赖：`agent/` 与 `apps/`；不得自行读取组织角色表或判断版本。资源写入归属、可见范围和操作授权统一由 `AccessControlModule` 提供。
