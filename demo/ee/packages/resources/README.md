# resources

EE 的资源领域扩展层，放置 CE 资源包之上的发布、审批、版本与客户业务规则。

当前子包：

- `enterprise-agent-config`：为 CE AgentConfig 新增独立的发布状态和发布门槛。

允许依赖：CE `resources/` 的公开 DTO/服务和 CE `platform/` 契约。

禁止依赖：`apps/`；不得复制 CE 的基础 CRUD，也不得把企业身份授权逻辑塞进领域服务。运行实例仍由 CE `AgentInstanceManager` 管理。
