# 去除 Workspace 路径，改用 orgId+userId 自动计算 执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标:** 去除智能体创建时的 workspace 路径输入，由 plugin-opencode 根据 organizationId + userId 自动计算用户隔离的工作区路径。

**技术栈:** Elysia + Bun, React + TanStack Router, Drizzle ORM, plugin-sdk, plugin-opencode

**设计文档:** `spec/feature_20260521_F001_auto-workspace/spec-design.md`

## 改动总览

- 本次改动涉及 SDK 类型层（plugin-sdk）、后端服务层（environment-web, launch-spec-builder, instance）、opencode runtime、前端 UI 和 i18n 共 ~15 个文件
- Task 1 是基础（类型 + 环境变量 + 路径解析工具），Task 2/3 依赖 Task 1 但互不依赖可并行，Task 4（前端）依赖 Task 2 的 API 变更
- 关键设计决策：workspace 路径算法为 `{WORKSPACE_ROOT ?? cwd/workspaces}/{orgId}/{userId}`，环境创建时由服务端自动计算并写入 DB，下游消费者（workspace-fs, agent-task-runner）无需改动读取逻辑

---

## 任务索引

### Task 0: 环境准备
📄 详情见: `spec-plan-task-0.md`

验证构建工具链和测试环境是否就绪。

### Task 1: SDK 类型变更 + 环境变量 + 路径解析工具
📄 详情见: `spec-plan-task-1.md`

修改 AgentLaunchSpec 类型（workspace → orgId + userId），注册 WORKSPACE_ROOT 环境变量，创建共享路径解析工具。

### Task 2: 后端服务层 + 路由适配
📄 详情见: `spec-plan-task-2.md`

适配 environment-web, launch-spec-builder, instance, schemas, routes，使 workspace 路径由服务端自动计算。

### Task 3: plugin-opencode runtime 适配
📄 详情见: `spec-plan-task-3.md`

在 opencode-runtime 中添加 resolveWorkspace()，更新 prepareEnvironment() 使用 AgentLaunchSpec 中的 orgId + userId。

### Task 4: 前端适配 + i18n
📄 详情见: `spec-plan-task-4.md`

移除 EnvironmentsPage 的 workspace 输入框、列表显示和 form state，删除对应 i18n key。

### Acceptance Task
📄 详情见: `spec-plan-acceptance.md`

端到端验证所有功能是否正确实现。
