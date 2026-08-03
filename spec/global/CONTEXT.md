# 领域上下文 (Domain Context)

> 最后更新：2026-08-03
> 来源：grill-with-docs 面试输出

## 项目概览

FenixAgent 是基于 Elysia + Bun 的多租户 ACP Agent 平台。

- **当前阶段**：架构规范化重构，从编排域起步
- **重构策略**：B 方案 — 从核心域模块切入，独立 `packages/orchestration/`
- **不在本次范围**：ChatChannelController、YJS transport、前端

## 核心领域术语

### 编排域

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

### 组织与权限域（不在此次范围）

| 术语 | 关联 |
|------|------|
| Organization | 多租户隔离边界 |
| User | 用户身份 |
| Team | 改动 11（待实施） |

### Chat 域（不在此次范围）

| 术语 | 关联 |
|------|------|
| ChatChannelController | Chat 入口，编排域产出 Instance 后消耗 |

## 当前目标架构

```
packages/orchestration/    ← 本次重构交付
    ↓ DI 构造函数注入
src/                      ← repo 实现、route 调用、Chat 侧消费
```

## 生效的 ADR

| ADR | 日期 | 状态 |
|-----|------|------|
| [编排域独立包设计](adr/2026-08-03-orchestration-package-design.md) | 2026-08-03 | ✅ 已确认 |

## 下一步

1. `/to-prd` — 将 ADR 合成为正式 PRD
2. `/to-issues` — 拆分为可独立实现的 issue
3. `/implement` — 逐个 issue 驱动 TDD + Code Review
