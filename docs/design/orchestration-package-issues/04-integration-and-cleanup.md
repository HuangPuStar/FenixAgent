# I4: 集成落地 — Repo 实现 + 调用方迁移 + 清理

## What to build

将 `packages/orchestration/` 集成到现有 `src/` 代码库中。实现 4 个 Repo 接口、迁移调用方到 AgentController、删除旧代码、废弃 `agent_session` 表。

这是编排域包和现有系统的"对接层"——编排域包通过接口消费数据，`src/` 侧实现这些接口并接入真实 DB/WS。

## 具体产出

### 1. 4 个 Repo 实现（`src/repositories/` 或 `src/services/`）

在 `src/` 侧实现包定义的 4 个 Repo 接口，接入真实 DB：

| Repo | 对应 DB 表 | 位置建议 |
|------|-----------|---------|
| `AgentConfigRepo` | `agent_config` + `skill` + `mcp_server` + `knowledge_base` 及关联表 | `src/repositories/agent-config.ts` 或新文件 |
| `EnvironmentRepo` | `environment` | `src/repositories/environment.ts` 或已有 repository 覆盖 |
| `AgentMachineRepo` | `agent_machine` | `src/repositories/agent-machine.ts` 或新文件 |
| `AgentEngineRepo` | `agent_engine` | `src/repositories/agent-engine.ts` 或新文件 |

**实现要求**：
- 通过 Drizzle ORM 查询，不走裸 SQL
- `AgentConfigRepo.getConfig()` 一次 JOIN 返回扁平聚合（技能/kb/mcp 列表）
- 处理 `null` 返回（记录不存在时返回 `null`）

### 2. 调用方迁移

将所有使用旧编排代码的调用方切换到 `AgentController`：

| 旧调用方 | 旧代码 | 新调用方式 |
|---------|--------|----------|
| `src/routes/api/openai-chat.ts` | 直接调 `services/instance.ts` / `services/agent-chat-service.ts` | `controller.spawnInstance()` → 拿到 Instance → chat 通过 `instance.send()` 对话 |
| `src/services/workflow/agent-chat-transport.ts` | 直接调 `services/instance.ts` | `controller.spawnInstance()` → 拿到 Instance |
| `src/transport/relay/yjs-frontend/` | 直接操作 relay handler，管理 session 生命周期 | ChatChannelController 通过 Instance 与编排域交互（如已在 I3 范围外则保留现有逻辑，走 Chat 域重构） |
| `src/services/agent-chat-service.ts` | 内部管理 instance spawn | 改为通过 Controller 获取 Instance |

**特别注意**：`agent-chat-service.ts` 是 Chat 域和编排域的交接点。迁移时保持 Chat 域逻辑不变，只替换 instance 获取方式。

### 3. 旧代码删除

按 grilling 确认的映射表删除旧代码：

| 删除/大幅精简的文件 | 迁移到的位置 |
|-------------------|------------|
| `services/instance.ts` | `agent-controller/index.ts` + `instance/instance.ts` |
| `services/launch-spec-builder.ts` | `launch-spec/launch-spec-builder.ts` |
| `transport/acp-ws-handler.ts`（编排部分） | 精简为纯 Chat/YJS 通道管理 |
| `transport/relay/relay-handler.ts`（编排部分） | `agent-node/agent-node.ts` + `agent-node/agent-node-service.ts` |
| `services/acp-idle-monitor.ts` | `agent-node-service.ts` 的空闲回收逻辑 |

### 4. 数据库迁移

- 生成 Drizzle 迁移：`bun run db:generate --name remove-agent-session`
- 确认迁移 SQL 正确（DROP TABLE agent_session + 关联索引/外键）
- 执行迁移：`bun run db:migrate`

### 5. AgentController 实例化

在 `src/index.ts` 中创建 `AgentController` 单例并注入依赖：

```ts
import { AgentController } from "@fenix/orchestration";

const controller = new AgentController({
  agentNodeService: new AgentNodeService({ idleTimeoutMs: ... }),
  launchSpecBuilder: new LaunchSpecBuilder({
    agentConfigRepo: new AgentConfigRepoImpl(db),
    environmentRepo: new EnvironmentRepoImpl(db),
    agentEngineRepo: new AgentEngineRepoImpl(db),
  }),
  environmentRepo: new EnvironmentRepoImpl(db),
});
```

## Acceptance criteria

- [ ] 4 个 Repo 实现通过 DB 查询返回正确数据
- [ ] `AgentConfigRepo.getConfig()` 返回扁平聚合（含 skills/kb/mcp）
- [ ] 所有旧调用方迁移完成，无直接引用 `services/instance.ts` 的编排逻辑
- [ ] `services/instance.ts`、`services/launch-spec-builder.ts` 等旧代码已删除或精简
- [ ] `agent_session` 表迁移执行成功
- [ ] `bun test src/__tests__/` 无回归
- [ ] `bun test packages/orchestration/` 全绿
- [ ] `bun run precheck` 全绿
- [ ] `bun run build:web` 成功（前端无影响）

## Blocked by

[I3: AgentController](03-agent-controller-spawn.md)
