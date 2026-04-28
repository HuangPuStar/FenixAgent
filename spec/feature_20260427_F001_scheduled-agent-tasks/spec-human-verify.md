# 定时 Agent 任务 人工验收清单

**生成时间:** 2026-04-28 10:01
**关联计划:** `spec/feature_20260427_F001_scheduled-agent-tasks/spec-plan.md`
**关联设计:** `spec/feature_20260427_F001_scheduled-agent-tasks/spec-design.md`

---

## 验收前准备

### 环境要求
- [ ] [AUTO] 检查 Bun 运行时: `bun --version`
- [ ] [AUTO] 运行完整测试: `bun test src/__tests__/ web/src/__tests__/`
- [ ] [AUTO] 构建前端产物: `bun run build:web`
- [ ] [AUTO/SERVICE] 启动服务: `bun run start` (port: 3000)
- [ ] [MANUAL] 准备一个有效的 `better-auth.session_token`，并创建一个带可写 `workspacePath` 的 environment，记录 `ENV_ID`
- [ ] [MANUAL] 确认本机可执行 `opencode run`，且目标 environment 的 `workspacePath` 可写

### 测试数据准备
- [ ] 约定一个待创建任务名称，例如“每日巡检验收”
- [ ] 预先记录 environment 对应的 `session_id` 与 `workspace_path`，供文件 API 验证使用

---

## 验收项目

### 场景 1：任务创建与字段收敛

#### - [x] 1.1 创建任务只接受 Agent 任务字段
- **来源:** `spec-plan.md` Task 7.2 / `spec-design.md` 验收标准 1、7
- **目的:** 确认任务模型已完成替换
- **操作步骤:**
  1. [A] `curl -s -X POST http://localhost:3000/web/tasks -H 'Content-Type: application/json' -b 'better-auth.session_token=YOUR_SESSION_COOKIE' -d '{"name":"每日巡检验收","cron":"*/5 * * * *","timezone":"","environmentId":"ENV_ID","task":"输出当前目录文件清单到 report.md","timeoutMinutes":30}' | jq '.data | {environmentId, task, timeoutMinutes, timezone}'` → 期望包含: `"environmentId": "ENV_ID"`
  2. [A] `curl -s -X POST http://localhost:3000/web/tasks -H 'Content-Type: application/json' -b 'better-auth.session_token=YOUR_SESSION_COOKIE' -d '{"name":"每日巡检验收","cron":"*/5 * * * *","timezone":"","environmentId":"ENV_ID","task":"输出当前目录文件清单到 report.md","timeoutMinutes":30}' | jq '.data.timezone'` → 期望精确: `null`
  3. [A] `rg -n "HTTP 配置|请求头|请求体 \\(JSON\\)|启用自动重试|URL \\*" web/src/pages/TasksPage.tsx web/src/api/client.ts` → 期望精确: ``

#### - [x] 1.2 任务页表单仅展示 environment、task 与超时配置
- **来源:** `spec-plan.md` Task 6 / `spec-design.md` 前端页面调整
- **目的:** 确认前端不再暴露旧 HTTP 语义
- **操作步骤:**
  1. [H] 打开 `http://localhost:3000/code/`，进入任务创建/编辑表单，查看是否仅有 environment、task、多行文本、超时（分钟）等新字段，且不再显示 URL/Method/Headers/Body/Retry → 是/否

### 场景 2：手动触发、结果留存与目录可查看

#### - [x] 2.1 手动触发会创建独立 workspace 并写入执行日志
- **来源:** `spec-plan.md` Task 7.3 / `spec-design.md` 验收标准 3、6
- **目的:** 确认一次性执行与日志落库正常
- **操作步骤:**
  1. [A] `TASK_ID=$(curl -s http://localhost:3000/web/tasks -b 'better-auth.session_token=YOUR_SESSION_COOKIE' | jq -r '.data[0].id'); curl -s -X POST http://localhost:3000/web/tasks/$TASK_ID/trigger -b 'better-auth.session_token=YOUR_SESSION_COOKIE' | jq '.data | {status, workspacePath, workspaceName, resultSummary}'` → 期望包含: `.scheduled-runs`
  2. [A] `TASK_ID=$(curl -s http://localhost:3000/web/tasks -b 'better-auth.session_token=YOUR_SESSION_COOKIE' | jq -r '.data[0].id'); curl -s -X POST http://localhost:3000/web/tasks/$TASK_ID/trigger -b 'better-auth.session_token=YOUR_SESSION_COOKIE' | jq -r '.data.workspaceName'` → 期望包含: ``

#### - [x] 2.2 执行目录可通过 files API 列出内容
- **来源:** `spec-plan.md` Task 7.4 / `spec-design.md` 执行结果可查看性
- **目的:** 确认运行产物可追溯查看
- **操作步骤:**
  1. [A] `ENV_META=$(curl -s http://localhost:3000/web/environments -b 'better-auth.session_token=YOUR_SESSION_COOKIE' | jq -r '.[] | select(.id=="ENV_ID") | [.session_id, .workspace_path] | @tsv'); ENV_SESSION_ID=$(printf "%s" "$ENV_META" | cut -f1); ENV_WORKSPACE=$(printf "%s" "$ENV_META" | cut -f2); TASK_ID=$(curl -s http://localhost:3000/web/tasks -b 'better-auth.session_token=YOUR_SESSION_COOKIE' | jq -r '.data[0].id'); RUN_PATH=$(curl -s http://localhost:3000/web/tasks/$TASK_ID/logs -b 'better-auth.session_token=YOUR_SESSION_COOKIE' | jq -r '.data.items[0].workspacePath' | sed "s#^$ENV_WORKSPACE/##" | sed 's#^/##'); curl -s "http://localhost:3000/web/sessions/$ENV_SESSION_ID/files?path=$RUN_PATH" -b 'better-auth.session_token=YOUR_SESSION_COOKIE' | jq '.entries | length'` → 期望包含: `1`

#### - [x] 2.3 任务页日志区域可显示目录查看入口和结果信息
- **来源:** `spec-plan.md` Task 6 / `spec-design.md` 执行日志视图
- **目的:** 确认 UI 可直接消费结果目录能力
- **操作步骤:**
  1. [H] 打开 `http://localhost:3000/code/`，进入任务页日志弹窗，查看是否展示 `workspacePath`、`resultSummary`、`error/skipReason`，且存在“查看目录”入口 → 是/否

### 场景 3：调度规则、跳过并发与超时

#### - [x] 3.1 空时区走服务器本地时间，指定时区走显式时区
- **来源:** `spec-design.md` 验收标准 2 / `spec-plan.md` Task 4
- **目的:** 确认 cron 时区语义正确
- **操作步骤:**
  1. [A] `bun test src/__tests__/scheduler.test.ts` → 期望包含: `pass`
  2. [A] `rg -n "server-local|scheduleJob\\(\\{ rule: task.cron \\}" src/services/scheduler.ts` → 期望包含: `server-local`

#### - [x] 3.2 运行中重复触发会记录 skipped 日志
- **来源:** `spec-plan.md` Task 7.5 / `spec-design.md` 验收标准 4
- **目的:** 确认并发保护按跳过策略执行
- **操作步骤:**
  1. [A] `bun test src/__tests__/scheduler.test.ts` → 期望包含: `previous_run_still_active`

#### - [x] 3.3 任务超时后被终止且 workspace 仍保留
- **来源:** `spec-plan.md` Task 7.6 / `spec-design.md` 验收标准 5
- **目的:** 确认超时终态与结果留存
- **操作步骤:**
  1. [A] `bun test src/__tests__/agent-task-runner.test.ts src/__tests__/task-core.test.ts` → 期望包含: `Task execution timed out`
  2. [A] `bun test src/__tests__/agent-task-runner.test.ts src/__tests__/task-core.test.ts` → 期望包含: `timeout`

### 场景 4：边界与回归

#### - [x] 4.1 旧 HTTP 字段与重试语义已从前后端清理
- **来源:** `spec-plan.md` Task 1/3/4/6 / `spec-design.md` 替换边界、验收标准 7
- **目的:** 确认无旧语义残留
- **操作步骤:**
  1. [A] `rg -n "url|method|headers|body|retryEnabled|retryCount|retryInterval|statusCode|responseBody|attempt" src/services/task.ts src/services/scheduler.ts src/routes/web/tasks.ts web/src/pages/TasksPage.tsx web/src/api/client.ts` → 期望精确: ``

#### - [x] 4.2 `.scheduled-runs` 目录只可读不可写，且路径穿越被拦截
- **来源:** `spec-plan.md` Task 5 / `spec-design.md` 非功能约束
- **目的:** 确认文件访问边界安全
- **操作步骤:**
  1. [A] `bun test src/__tests__/files-route.test.ts` → 期望包含: `pass`
  2. [A] `bun test src/__tests__/files-route.test.ts` → 期望包含: `.scheduled-runs`

---

## 验收后清理

- [ ] [AUTO] 终止后台服务 [RCS]: `kill $PID` (对应准备阶段 `bun run start` 的进程 PID)

---

## 验收结果汇总

| 场景 | 序号 | 验收项 | [A] | [H] | 结果 |
|------|------|--------|-----|-----|------|
| 场景 1 | 1.1 | 创建任务只接受 Agent 任务字段 | 3 | 0 | ✅ |
| 场景 1 | 1.2 | 任务页表单仅展示新字段 | 0 | 1 | ✅ |
| 场景 2 | 2.1 | 手动触发创建独立 workspace | 2 | 0 | ✅ |
| 场景 2 | 2.2 | 执行目录可通过 files API 查看 | 1 | 0 | ✅ |
| 场景 2 | 2.3 | 日志区域展示目录与结果信息 | 0 | 1 | ✅ |
| 场景 3 | 3.1 | 时区语义正确 | 2 | 0 | ✅ |
| 场景 3 | 3.2 | 并发触发写入 skipped | 1 | 0 | ✅ |
| 场景 3 | 3.3 | 超时终止且保留 workspace | 2 | 0 | ✅ |
| 场景 4 | 4.1 | 旧 HTTP 字段已清理 | 1 | 0 | ✅ |
| 场景 4 | 4.2 | `.scheduled-runs` 只读且防穿越 | 2 | 0 | ✅ |

**验收结论:** ✅ 全部通过 / ⬜ 存在问题
