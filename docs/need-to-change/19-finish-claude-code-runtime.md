# 19. 禁止把 Claude Code 占位 runtime 注册为生产能力

| 属性 | 结论 |
| --- | --- |
| 优先级 | P0 |
| 置信度 | 高；production bootstrap 可达 |
| 影响 | 假 running、虚假 relay 回显、子进程泄漏、错误 workspace |

## 对抗判决

默认生产 bootstrap 注册 Claude Code plugin，但其本地 runtime 使用相对 workspace、空 token、port 0；spawn 后不读 ready/退出；`connectRelay` 只是把 send 消息原样回显给 listener，close 为空操作。系统会把没有真实 Agent 通信的实例标记 running，并在上层 timeout/fallback 中制造假 session。

## 已核验证据

- `src/services/core-bootstrap.ts:63-86`：默认注册 `createClaudeCodePlugin()`。
- `packages/plugin-claude-code/src/runtime/claude-code-runtime.ts:30-52`：相对 workspace、硬编码 settings、port 0、空 token。
- `packages/plugin-claude-code/src/runtime/claude-code-runtime.ts:55-71`：不读取 stdout、不等待 ready、不监听退出。
- `packages/plugin-claude-code/src/runtime/claude-code-runtime.ts:73-90`：relay 仅回显，close no-op。
- `src/services/agent-chat-service.ts:264-333`：relay 缺能力/超时情况下会合成 sessionId，进一步掩盖假 runtime。

## 架构诊断

Claude plugin 重建了 process/relay lifecycle，而 opencode/ccb 已有较完整 Module。相似能力没有通过稳定 runtime interface 复用，插件差异与生命周期 implementation 混在一起，造成生产占位实现。

## 目标方向

- 立即从 production registry 移除/feature flag 禁用该 runtime，健康信息不得宣称可用。
- 复用统一 ProcessManager、relay authentication、ready handshake、exit monitoring 和 Binding；Claude plugin 只提供引擎差异。
- session/new/prompt/cancel 必须通过真实 ACP contract test；超时是失败，不合成 sessionId。
- 进程退出、RCS shutdown、relay disconnect 和 instance stop 都有单一 owner 与幂等清理。

## 验收

- production capability 只有通过真实进程 E2E/contract suite 才注册。
- 启动超时、进程早退、错误 token、relay 断开、cancel、shutdown 均收敛且无孤儿进程。
- 实例状态区分 starting/ready/degraded/stopped，不能仅因 spawn 成功报告 running。

## 删除条件

删除 `claude-code-runtime.ts` 中的回显 relay、相对 workspace 和空 lifecycle 兼容逻辑；不保留 deprecated 双实现。
