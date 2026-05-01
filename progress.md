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

## 2026-04-30 (Round 6)

### providers.ts 原子写入改造
- `handleSet`/`handleDelete`/`handleAddModel`/`handleUpdateModel`/`handleRemoveModel` 从 `getSection+replaceSection` 改为 `modifySection`，整个 read-modify-write 在同一把写锁内完成，消除并发竞态

### mcp.ts 原子写入改造
- `handleCreate`/`handleUpdate`/`handleDelete`/`handleEnable`/`handleDisable` 从 `getSection+replaceSection` 改为 `modifySection`，路由层补充 try-catch 兜底

### 测试补充
- 新建 `config-mcp-network.test.ts`：mock inspectRemoteMcpServer 和 db，覆盖 test/test_url/inspect/list_tools 4 个 action（+16 测试）
- 扩展 `config-providers.test.ts`：handleTest 不存在 provider + 并发 set 不丢数据（+2 测试）
- 更新 config-mcp.test.ts 和 config-providers.test.ts 的 mock：补充 modifySection 实现

## 2026-05-01 (Round 7) — UX Design Review

### index.css 组件类迁移
- index.css 从 1214 行精简至 273 行，所有自定义组件 CSS 类（dashboard-*、session-*、cp-* 等）迁移至 TSX 内联 Tailwind，删除大量无引用死代码。保留 @theme 变量、.dark 模式、滚动条、5 个 keyframes、reduced-motion。

### UX 修复
- App.tsx 初始加载添加品牌 spinner（替代纯文字"加载中..."），Suspense fallback 同步改进
- ApiKeyManager 复制按钮添加"已复制!"绿色反馈状态，创建框改为绿色成功样式（替代黄色警告样式）
- SessionDetail 加载失败页添加"重试"按钮（通过 retryKey 触发 useEffect 重新加载），中文化返回链接

### Round 7.2 — EnvironmentsPage UX 修复
- EnvironmentsPage 所有 7 处 alert() 弹窗替换为 toast.error()，消除阻塞式浏览器原生弹窗体验。表单验证改为 Dialog 内红色内联错误文字。Secret 对话框添加"已复制!"反馈和加粗黄色警告。Topbar 搜索框标记"功能开发中"降透明度防误点。

### Round 7.3 — 多页面文案与引导优化
- TasksPage cron 输入添加格式说明（分 时 日 月 周）和示例。任务内容 placeholder 增强为具体自然语言示例。启用/禁用文案简化为"关闭后定时任务将暂停，可通过立即执行手动运行"。
- AgentsPage 步数字段添加推荐值（简单 10-30/复杂 50-100）。隐藏和禁用复选框添加 title 提示说明各自作用。
- McpPage 服务器类型选择添加 Local/Remote 动态说明文字。

### Round 7.4 — 登录页/IdentityPanel + 测试全修
- LoginPage 添加密码可见性切换按钮（Eye/EyeOff 图标），placeholder 改为"至少 8 个字符"。错误提示添加红色背景圆角框更醒目。
- IdentityPanel 扫码失败 alert() 替换为 toast.error。至此全前端零 alert()。
- 修复 3 个 i18n 测试文件（app/dashboard/shared-components），导航项检查改为 Sidebar.tsx。前端测试从 390 pass / 10 fail 修复为 390 pass / 0 fail。

### Round 7.5 — 模型引导/聊天提示/ACP 空状态
- ModelsPage 上下文和输出限制字段添加说明文字（"模型单次对话/回复最大 token 数"）。
- ChatInput 底部提示扩展："粘贴图片或输入 @ 引用文件"。SessionDetail ChatView 空状态描述同步扩展。
- ACPMain 加载中文字替换为品牌 spinner。空会话列表添加"点击上方 + 创建新会话"引导文字。
