# 测试套件全面修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复全部 193 个失败测试，使 `bun test src/__tests__/` 全绿

**Architecture:** 按根因分类批量修复，优先修复影响面最大的模式（team_id NOT NULL → UUID 格式 → Schema 列引用 → Auth → 函数签名变更）

**Tech Stack:** Bun test, Drizzle ORM, PostgreSQL, Elysia

---

## 根因分类

| 类别 | 测试数 | 根因 | 修复策略 |
|------|--------|------|---------|
| A: team_id NOT NULL | ~60 | environment 等表插入缺少 team_id | 添加 team_id + ensureTeam() |
| B: UUID 格式 | ~50 | scheduled_task 用字符串 ID 当 UUID | 改用 UUID 格式 ID |
| C: Schema 列引用 | ~20 | 引用已删除的 environmentId/agentName | 更新断言 |
| D: Auth 401 | ~38 | routes.test.ts 认证失效 | 修复 auth mock |
| E: 函数签名变更 | ~25 | scheduler/session/ws-handler 签名变 | 更新测试代码 |

### Task 1: environment team_id 修复（Category A — 最大批次）

**Files:**
- Modify: `src/__tests__/acp-token-match.test.ts`
- Modify: `src/__tests__/api-key-service.test.ts`
- Modify: `src/__tests__/services.test.ts`
- Modify: `src/__tests__/work-dispatch.test.ts`
- Modify: `src/__tests__/files-route.test.ts`
- Modify: `src/__tests__/disconnect-monitor.test.ts`
- Modify: `src/__tests__/session-service.test.ts`
- Modify: `src/__tests__/skill-source-workspace-guard.test.ts`
- Modify: `src/__tests__/web-environments.test.ts`
- Modify: `src/__tests__/config-integration.test.ts`
- Modify: `src/__tests__/config-mcp.test.ts`
- Modify: `src/__tests__/config-mcp-network.test.ts`
- Modify: `src/__tests__/config-models.test.ts`
- Modify: `src/__tests__/config-providers.test.ts`
- Modify: `src/__tests__/config-skills.test.ts`
- Modify: `src/__tests__/channel-routes.test.ts`
- Modify: `src/__tests__/environment-core-utils.test.ts`

- [ ] 给每个测试文件添加 `TEST_TEAM_ID` 常量和 `ensureTeam()` 辅助函数
- [ ] 所有 `environmentRepo.create(...)` 调用添加 `teamId: TEST_TEAM_ID`
- [ ] 所有直接 `db.insert(environment).values(...)` 添加 `teamId: TEST_TEAM_ID`
- [ ] 运行全部测试验证通过

### Task 2: scheduled_task UUID 格式修复（Category B）

**Files:**
- Modify: `src/__tests__/task-core.test.ts`
- Modify: `src/__tests__/task-reschedule-conditional.test.ts`
- Modify: `src/__tests__/update-task-no-requery.test.ts`
- Modify: `src/__tests__/task-clear-logs-ownership.test.ts`
- Modify: `src/__tests__/validate-task-partial.test.ts`
- Modify: `src/__tests__/task-prefetch-content-type.test.ts`
- Modify: `src/__tests__/task-error-message-fallback.test.ts`
- Modify: `src/__tests__/task-timeout-detection.test.ts`
- Modify: `src/__tests__/task-routes.test.ts`
- Modify: `src/__tests__/write-log-fire-forget.test.ts`
- Modify: `src/__tests__/write-log-no-duplicate.test.ts`
- Modify: `src/__tests__/scheduler*.test.ts` (所有 scheduler 相关)

- [ ] 所有 scheduled_task 的 user_id/team_id 改为 UUID 格式
- [ ] 运行全部测试验证通过

### Task 3: Schema 列引用修复（Category C）

**Files:**
- Modify: `src/__tests__/task-schema.test.ts`
- Modify: `src/__tests__/environment-core-utils.test.ts`

- [ ] 删除对 environmentId、agentName 等已删除列的引用
- [ ] 更新断言匹配当前 schema
- [ ] 运行全部测试验证通过

### Task 4: routes.test.ts Auth 401 修复（Category D）

**Files:**
- Modify: `src/__tests__/routes.test.ts`
- Modify: `src/__tests__/middleware.test.ts`

- [ ] 分析 routes.test.ts 认证流程，修复 mock 使 auth 返回 200
- [ ] 修复 middleware.test.ts 的 mock 隔离问题
- [ ] 运行全部测试验证通过

### Task 5: 函数签名/行为变更修复（Category E）

**Files:**
- Modify: `src/__tests__/ws-handler.test.ts`
- Modify: `src/__tests__/sse-writer.test.ts`
- Modify: `src/__tests__/workflow-proxy.test.ts`
- Modify: `src/__tests__/knowledge-mcp-route.test.ts`
- Modify: `src/__tests__/web-knowledge-bases.test.ts`
- Modify: `src/__tests__/web-knowledge-resources.test.ts`
- Modify: `src/__tests__/channel-binding*.test.ts`
- Modify: `src/__tests__/instance-service.test.ts`
- Modify: `src/__tests__/instance-*.test.ts`
- Modify: `src/__tests__/agent-task-runner.test.ts`
- Modify: `src/__tests__/scheduler*.test.ts`
- Modify: `src/__tests__/session-async-cleanup.test.ts`
- Modify: `src/__tests__/skill-import*.test.ts`
- Modify: `src/__tests__/skill-service.test.ts`
- Modify: `src/__tests__/set-skill-rollback.test.ts`
- Modify: `src/__tests__/mcp-agent-config-upsert.test.ts`
- Modify: `src/__tests__/model-build-values.test.ts`
- Modify: `src/__tests__/agent-config-create-single-loop.test.ts`
- Modify: `src/__tests__/agent-knowledge.test.ts`

- [ ] 逐个文件分析具体失败原因并修复
- [ ] 运行全部测试验证通过

### Task 6: 全量测试验证

- [ ] 运行 `bun test src/__tests__/` 确认 0 fail
- [ ] 运行 `bun run typecheck` 确认类型检查通过
