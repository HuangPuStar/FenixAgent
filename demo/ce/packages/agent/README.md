# agent

CE 的 Agent 核心层，承载引擎适配、实例运行、聊天、会话与连接等无资源授权语义的能力。

当前子包：

- `agent-runtime`：引擎运行时契约与默认静态实现。
- `agent-instance`：`AgentInstanceManager`，即实例创建与运行内核。
- `agent-chat`：后续放置 Chat、会话、relay、YJS 等 Agent 交互能力。

允许依赖：`platform/` 的稳定契约。

禁止放入：资源 CRUD、身份授权、EE 发布规则、页面或资源 route。启动 AgentConfig 的 `use` 校验与配置到 `agentId` 的映射属于资源 Facade；InstanceManager 只接收通用运行时参数。
