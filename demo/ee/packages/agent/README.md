# agent

EE 的 Agent 核心扩展层预留位置。

当前 demo 没有 EE agent 包：EE 直接复用 CE 的 `AgentRuntimeModule` 与 `AgentInstanceManager`。AgentConfig 的发布限制在资源 Facade 中完成，不应为此创建一套 Enterprise Instance 生命周期或复制 Manager。

未来只有确实属于 Agent 核心且无法通过资源授权入口表达的能力（例如企业运行审计 sink、配额调度器、Chat transport）才放入该层，并通过 CE agent 的公开静态扩展点装配。

禁止放入：身份授权规则、资源 CRUD 与发布状态。
