# C7 · 宿主桥接与路由接线

> 来源：`docs/design/2026-08-04-yjs-chat-streaming-prd.md`（Q10）
> 性质：收口切片（复制编排域桥接模式）

## What to build

建立包与宿主的桥接层：包内定义 `ChatChannelDependencies` 依赖接口，`src/services/chat-channel-bootstrap.ts` 负责装配与单例缓存；`src/` 侧路由与业务入口改调桥接；删除 `src/transport/relay/yjs-frontend/` 残留与 facade，收敛宿主依赖。

### 实现内容

1. **依赖接口**：包内定义 `ChatChannelDependencies`（构造器注入）：环境解析（environmentRepo 语义）、workspace 注入（`resolveWorkspacePath` 语义）、实例生命周期（`ensureRunning` / `spawnInstanceViaController` 语义）、relay 发送（`sendToInstanceRelay` 语义）、Redis 存储（cache/yjs-store 语义）、日志；`yjs-frontend` 现有对 `environmentRepo` / `resolveWorkspacePath` / `acp-idle-monitor` / `cache` 的直接 import 全部收敛为接口。
2. **装配层**：`src/services/chat-channel-bootstrap.ts`（参照 `orchestration-bootstrap.ts`）：从 `src/` 侧注入实现，缓存单例（`getChatChannelController()` + `resetChatChannelBootstrap()` 供测试）。
3. **路由接线**：`src/routes/acp/index.ts` 等 WS 入口改调 bootstrap 获取控制器；删除 `src/transport/relay/yjs-frontend.ts` facade 与 `src/transport/relay/yjs-frontend/` 目录（其职责已由 C3/C4/C6 迁入包内）。
4. **与编排域衔接**：CommandCoordinator 在 `load_session` / 首次需要 Agent 的 Action 时调用 `ensureRunning(environmentId, agentConfigId)`（场景 K：先复用可复用实例，仅创建新实例时检查并发配额）；`spawnInstanceViaController` 创建独立实例并负责销毁；`acpSessionId` 由服务端 translator 注入 `cwd`，浏览器不可覆盖。
5. **隔离校验**：组织隔离（organizationId 命名空间贯穿存储/缓存/广播键）、Agent 配置隔离（服务端从会话绑定解析可信配置，忽略客户端覆盖字段）、`rcsSessionId` 唯一命名两份 Doc / 广播 / 缓存 / relay handle。

## Acceptance criteria

- [ ] `chat-channel-bootstrap.ts` 建成，路由改调桥接；`src/transport/relay/yjs-frontend/` 与 facade 已删除
- [ ] 包内无任何对 `src/` 宿主的直接 import（grep 验证，依赖全部走 `ChatChannelDependencies`）
- [ ] 控制器单例可注入 fake 依赖（测试可复用）；`resetChatChannelBootstrap` 生效
- [ ] `ensureRunning` 复用语义验证：并发受限时先复用、仅新建检查配额（场景 K 测试）
- [ ] 多租户隔离测试：组织 A/B 会话、资源 ID 越权提交被拒绝；`rcsSessionId` 隔离无串流
- [ ] `bun run precheck` 全绿；`bun run build:web` 通过；`bun run check:deps` 干净

## Blocked by

- C3（CommandCoordinator 就位，桥接才有组装对象）
- C6（连接层迁入包内，facade 才能删除）
