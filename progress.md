# Code Review & Optimization Progress

## 2026-04-29 (Round 1)

### store.ts 优化
- 修复 `storeReset()` 未清理 `sessionOwners` 和 `workItems` 的 bug，避免测试间状态泄漏

### task.ts 优化
- `deleteTask` 改为先查后删模式（async），替代依赖 SQLite `changes()` 的同步 `.run()` 方式
- `clearExecutionLogs` 补充缺失的 `await`，确保异步操作正确完成

### config.ts 优化
- 提取 `ensureConfigDir()` 消除 4 处重复的 `mkdir` 目录确保逻辑
- 新增 `CONFIG_DIR` 常量替代 `join(CONFIG_PATH, "..")` 的间接路径计算

### 测试补充
- 新增 `session-service.test.ts`：覆盖 `toWebSessionId`、`isSessionClosedStatus`、`resolveExistingSessionId`、`resolveOwnedWebSessionId`（含 auto-bind）、`listWebSessionsByOwnerUuid`、`touchSession` 等函数，共 23 个测试
- 扩展 `store.test.ts`：补充 Session Ownership、Work Items、Session Workers、storeListAllEnvironments 测试，新增 11 个测试

## 2026-04-29 (Round 2)

### work-dispatch.ts 优化
- 合并重复的 `config` 和 `getBaseUrl` import 为单行
- 移除 `heartbeatWork` 中的 `as any` 类型断言，传入空对象即可触发 updatedAt 更新

### web/environments.ts 路由优化
- `sanitizeResponse` 参数类型从 `any` 改为 `EnvironmentRecord`，增强类型安全
- `storeUpdateEnvironment` 的 patch 类型从 `Record<string, unknown>` 改为 `Partial<Pick<EnvironmentRecord, ...>>`，防止非法字段传入
- 添加 `EnvironmentRecord` 类型导入

### 测试补充
- 新增 `mcp-inspector.test.ts`（7 个测试）：验证 McpInspectResult/McpToolItem 类型结构和 URL 校验

## 2026-04-29 (Round 3)

### 可执行文件解析工具提取
- 提取 `src/utils/executable.ts` 共享模块，合并 `instance.ts` 和 `agent-task-runner.ts` 中重复的 `isExecutable` + `resolveExecutable` 函数
- 新的 `resolveExecutable` 集成三种解析策略：local node_modules/.bin → PATH 遍历 → system which/where

### disconnect-monitor.ts 优化
- 合并两行重复的 `"../store"` import 为单行

### 测试补充
- 新增 `executable.test.ts`（7 个测试）：验证 isExecutable 和 resolveExecutable 的正确性

## 2026-04-30 (Round 4)

### api-key-service.ts 优化
- `deleteApiKey` 和 `updateApiKeyLabel` 从同步 `.run() as any` 改为先查后删/改的 async 模式，消除 `as any` 类型断言和依赖 SQLite `changes()` 的同步模式，与 Round 1 中 task.ts 的修复保持一致

### acp-relay-handler.ts 优化
- 提取 `forwardFilteredLines()` 消除 reused connection 和 new connection 两处重复的 keep_alive/error 过滤逻辑（约 30 行重复代码合并为共享函数）

### environment.ts 优化
- 移除未使用的 `config` import（`import { config } from "../config"`）

### 测试补充
- 新增 `api-key-service.test.ts`（13 个测试）：覆盖 createApiKey、validateApiKeyAndGetUser、listApiKeysByUser、deleteApiKey（含权限校验）、updateApiKeyLabel（含权限校验）
- 扩展 `event-bus.test.ts`：补充 event eviction 策略测试，验证超过 MAX_EVENTS_PER_BUS 时旧事件被正确驱逐

## 2026-04-30 (Round 5)

### skills.ts 路由类型安全
- 7 个 handler 函数（handleList/handleGet/handleSet/handleDelete/handleEnable/handleDisable/handleUpload）的 `c` 参数从 `any` 改为 Hono `Context` 类型

### models.ts 缓存失效修复
- `handleSet` 写入配置后立即清除 `cachedAvailable` 缓存，防止后续 get 请求返回过期模型列表

### providers.ts 写入策略修正
- `handleSet`/`handleAddModel`/`handleUpdateModel` 从 `setSection`（deep merge）改为 `replaceSection`，避免 deep merge 不删除旧 key 的问题
- 移除不再使用的 `setSection` import

### 测试补充
- 扩展 `config-models.test.ts`：缓存失效测试 + 模型 context/output limit 解析测试（+2 测试）
- 扩展 `config-providers.test.ts`：replaceSection 保留 key 测试 + add_model 不存在 provider 测试（+2 测试）
