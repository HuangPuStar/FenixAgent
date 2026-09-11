# Agent Runtime

`@fenix/agent-runtime` 是 Environment、Instance、Runtime、relay、ACP session、Chat 与 YJS 的单一 workspace package 边界。这些能力共同组成有状态 Agent 运行子系统，不按运行阶段拆分 package。

assembly 使用 `agentRuntime` 槽位，以及稳定 module ID 和 module kind `agent-runtime`。包内可按职责组织目录，但不得将 Instance、Chat 或 YJS 等职责拆成独立 workspace package；跨包调用只使用公开 exports 和启动端口。
