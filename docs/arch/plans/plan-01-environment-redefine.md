# Plan 01：Environment 定位重新定义

## Context

Environment 当前被描述为"Agent 工作空间"，定位模糊，实际承担了过多隐含职责。需要重新定义为**资源管理层**，明确其职责边界。

## 现状分析

当前代码中 Environment 实际行为已经是资源管理层：
- `src/services/instance.ts`：`spawnInstanceFromEnvironment()` 负责 spawn Agent Instance
- `src/index.ts`：autoStart 遍历环境触发 spawn
- Environment 表包含 `maxSessions`、`autoStart`、`workerType` 等调度相关字段

**关键发现**：代码行为已经符合目标定位，本次改动主要是文档对齐。

## 改动范围

### 文件清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `docs/arch/16-domain-model.md` | 编辑 | 更新 Environment 的定位描述 |
| `docs/arch/05-instance.md` | 编辑 | 补充 Environment 作为资源管理层的说明 |
| `docs/arch/00-overview.md` | 编辑 | 同步架构概述 |
| `CLAUDE.md` | 编辑 | 更新项目概述中 Environment 的描述 |

### 具体改动

1. **`docs/arch/16-domain-model.md`**：
   - Environment 定义从"Agent 工作空间"改为"资源管理层"
   - 补充职责列表：调度 Instance 生命周期、根据 AgentConfig 拉取 Skill、同步 MCP 配置、同步 Knowledge 绑定
   - 更新概念卡片

2. **`docs/arch/05-instance.md`**：
   - 明确 Environment 与 Instance 的关系：Environment 调度 Instance，不是 Instance 的容器

3. **`docs/arch/00-overview.md`**：
   - 架构概述中 Environment 定位同步更新

4. **`CLAUDE.md`**：
   - 项目概述段落中的 Environment 描述同步更新

## 验证方式

- 纯文档改动，无需运行测试
- 检查所有文档中 "工作空间" 描述是否已更新为 "资源管理层"
- `grep -r "工作空间" docs/arch/` 确认无遗漏

## 依赖关系

- 无代码改动，不依赖其他 Plan
- 可独立实施
