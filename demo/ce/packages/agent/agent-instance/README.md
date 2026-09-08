# @fenix-ce/agent-instance

运行时实例管理包。

包含：

- `AgentInstanceManager`：创建实例标识、调用引擎；未来放置实例复用、停止、租约、并发控制和回收。

允许依赖：`agent-runtime` 和基础契约。

禁止放入：`agent-config:use` 校验、actor、AgentConfig 标识、发布状态、组织/工作空间规则、EE 审计计费或客户配额。Instance 不是资源，Manager 没有 Instance 权限；资源层将配置映射为通用 `agentId` 后通过 `AgentInstanceStarter` 端口调用它。
