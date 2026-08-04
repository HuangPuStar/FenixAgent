# 领域上下文 (Domain Context)

> 最后更新：2026-08-04
> 来源：grill-with-docs 面试输出（编排域 2026-08-03、Chat 域 2026-08-04）

## 项目概览

FenixAgent 是基于 Elysia + Bun 的多租户 ACP Agent 平台。

- **当前阶段**：架构规范化重构——编排域已完成（`packages/orchestration`，215 测试全绿），正在推进 Chat 流式链路域（`packages/chat-channel`）
- **重构策略**：B 方案 — 从核心域模块切入，独立 workspace 包 + 宿主桥接（bootstrap 装配）
- **本次范围**：Chat 域（YJS Chat Streaming 目标架构落地，见 `docs/arch/19-yjs-chat-streaming.md` 与 `docs/design/2026-08-04-yjs-chat-streaming-prd.md`）

## 核心领域术语

### 编排域（已完成，见 `docs/arch/20-orchestration-management.md`）

| 术语 | 定义 | DB 表 | 备注 |
|------|------|-------|------|
| **AgentConfig** | Agent 的配置蓝图，定义 Agent 是什么及能做什么 | `agent_config` | 编排域只读 |
| **Environment** | 资源管理层，调度 Instance 生命周期 | `environment` | agentConfigId 强绑定，非 agentConfigName |
| **Instance** | 纯运行时类，Agent 的运行载体 | 无 | N:1 绑定 AgentNode |
| **AgentNode** | 远端 Machine 在本侧的连接管理，持有 WS | 无 | 被动连接 |
| **AgentNodeService** | AgentNode 生命周期管理 | 无 | 引用计数 + 空闲超时 |
| **AgentController** | 编排域统一入口 | 无 | `spawnInstance()` 等 |
| **Machine** | 远端运行面，被 AgentNode 抽象化 | `agent_machine` | 编排域只读 |
| **Engine** | Agent 引擎类型（opencode / claude-code / ccb） | `agent_engine` | 编排域只读 |
| **Session** | ACP 会话 | `agent_session`（已废弃） | 下沉到 Agent 进程 |

### Chat 域（本次重构，目标架构 `docs/arch/19-yjs-chat-streaming.md`）

| 术语 | 定义 | 备注 |
|------|------|------|
| **rcsSessionId** | 前端 Agent 实例唯一标识（`rcs_*`，确定性生成） | 命名 Chat Doc / Session Doc / 广播通道 / 去重表 |
| **Turn** | 一次用户请求 → Agent 回复的完整执行单元（状态机：accepting → running → awaiting_permission → cancelling → 终态） | 终态不可逆；每会话单活动 turn |
| **Chat Doc** | `chat:{rcsSessionId}`，消息时间线投影（高频） | entries/blocks 结构 |
| **Session Doc** | `session:{rcsSessionId}`，会话元信息 / Agent 状态 / pendingPermissions（低频） | activeTurn、agent、pendingPermissions |
| **Yjs Gateway** | 前端 WebSocket 接入（认证、限流、协议解码、心跳、背压） | 连接级 |
| **SessionChannel** | 连接绑定至安全上下文与会话频道，路由 Action/Update | 协议层测试 seam |
| **CommandCoordinator** | Action 校验、commandId 幂等、命令串行化、turn 状态机驱动 | |
| **ACPChannel** | ACP 协议适配：命令转发、私有帧规范化为事件 | acp-link 私有帧 → 规范化事件 |
| **EventAggregator** | 规范化事件 → Y.Doc 有界聚合 | 只消费 session/update 语义 |
| **DocManager** | Y.Doc 镜像与 update 生成 | |
| **YjsBroadcaster** | 同 rcsSessionId 客户端 fan-out 与背压 | |
| **Action / Ack** | 前端命令信封（commandId）+ 两阶段确认（accepted/committed/duplicate） | 前端只发 commandId（UUID） |
| **commandId 去重表** | 防重复副作用：重复 Action 返回原 Ack，不重复调用 Agent | 进程内 Map，随实例生命周期 |
| **pendingPermissions** | Session Doc 中的待授权权限请求，CAS 解析（仅 pending→resolved 一次） | |
| **leaseEpoch** | 租约 fencing 字段（**仅类型占位**，运行时恒为固定值） | 事件日志/租约不实现（YJS CRDT 已保证文档一致性） |

### 组织与权限域（不在此次范围）

| 术语 | 关联 |
|------|------|
| Organization | 多租户隔离边界 |
| User | 用户身份 |
| Team | 改动 11（待实施） |

## 当前目标架构

```
packages/orchestration/    ← 编排域（已完成）
packages/chat-channel/     ← Chat 域（本次重构，合并原 acp-server 包）
    ↓ DI 构造函数注入
src/                       ← repo 实现、route 调用、bootstrap 装配（chat-channel-bootstrap.ts）
    ↓ 类型单一来源
web/                       ← 组件直接 import @fenix/chat-channel（web/src/acp/ 已删除）
```

## 生效的 ADR

| ADR | 日期 | 状态 |
|-----|------|------|
| [编排域独立包设计](adr/2026-08-03-orchestration-package-design.md) | 2026-08-03 | ✅ 已确认 |
| [Chat 域独立包设计](adr/2026-08-04-chat-channel-package-design.md) | 2026-08-04 | ✅ 已确认 |

## 下一步

1. ✅ `/to-prd` — PRD 已产出（`docs/design/2026-08-04-yjs-chat-streaming-prd.md`），待发布禅道（禅道服务端 502，恢复后发布）
2. `/to-issues` — 拆分为可独立实现的 issue
3. `/implement` — 逐个 issue 驱动 TDD + Code Review
