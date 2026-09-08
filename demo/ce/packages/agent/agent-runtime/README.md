# @fenix-ce/agent-runtime

定义 Agent 引擎运行时的稳定契约，并提供 CE 默认引擎实例。

包含：`AgentRuntimeModule` 与引擎执行入口。多引擎、RAG provider、Sandbox 等天然多实现能力可在此类稳定端口下静态替换。

允许依赖：基础契约和引擎适配器。

禁止放入：实例权限、身份授权、AgentConfig CRUD、发布流程与业务资源配置。
