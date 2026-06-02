# 关闭 Auto Start 服务端启动循环

**日期**: 2026-06-02
**状态**: Approved

## 背景

当前服务器启动时会遍历所有 `autoStart=true` 的 environment 并自动 spawn 实例（`src/index.ts` 第 67-96 行）。这导致服务器重启时大量实例同时启动，资源消耗不可控。

## 目标

移除服务器启动时的批量 auto-spawn，改为按需懒启动：当 API 调用需要运行中的实例时，检查 `autoStart` 标记决定是否自动 spawn。

## 设计

### 1. 移除服务器启动 auto-spawn 循环

删除 `src/index.ts` 中 `// Auto-start instances for all environments on server boot` 对应的 IIFE 块（约第 67-96 行）。服务器重启后不再主动 spawn 任何实例。

### 2. `ensureRunning` 加入 `autoStart` 门控

当前 `ensureRunning`（`src/services/instance.ts`）无条件 spawn——只要没有运行中的实例就创建。改为：

- 查询 environment 记录后检查 `autoStart` 字段
- `autoStart === true`：执行 spawn（保持现有行为）
- `autoStart === false`：抛出明确错误（`Instance not running and autoStart is disabled`），调用方可返回适当状态码

`ensureRunning` 当前代码已查询 `env = await environmentRepo.getById(environmentId)`，可直接读取 `env.autoStart`，无需额外 DB 查询。

### 3. 响应策略

`ensureRunning` 返回 `{ instance, status: "spawned" }` 时，各调用方按现有逻辑处理：

- **relay-handler**：现有 WebSocket 消息流已处理实例启动过程，无需额外改动
- **workflow**：现有 `createChannelFactory` 已处理 `status === "spawned"` 情况，无需额外改动
- **enterEnvironment**：路由层已有状态返回，无需额外改动

## 不变的部分

- DB `environment.auto_start` 字段保留
- 前端创建/编辑环境的"自启"开关保留
- 创建新环境时的即时 spawn 保留（`src/routes/web/environments.ts` 第 70-74 行）
- Workflow 调用 `ensureRunning` 的行为不变

## 影响范围

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `src/index.ts` | 删除 | 移除 auto-start IIFE 块 |
| `src/services/instance.ts` | 修改 | `ensureRunning` 加 autoStart 检查 |

前端无需改动，DB schema 无需迁移。
