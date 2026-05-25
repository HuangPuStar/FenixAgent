# core-plugin-refactor（阶段三：Server/Web 接管、兼容策略与总验收）执行计划

**目标:** 让 `mothership/apps/server` 与 `mothership/apps/web` 基于新 Core / Plugin 独立运行，同时明确新工程自己的存储路径与持久化边界。

**技术栈:** Bun, TypeScript, Hono, React, Vite, SQLite, Bun test

**设计文档:** `spec/feature_20260502_F001_core-plugin-refactor/spec-design.md`

## 改动总览

本阶段承接前两份计划的产物，把 `apps/server` 从占位入口扩展为真正的 composition layer，再补最小 `apps/web` 控制台与新工程自己的存储边界。经代码分析确认，现有根工程的 HTTP/WS 路由、静态文件服务、better-auth、自动启动环境与 ACP relay 全部堆在 `src/index.ts` 和 `src/routes/acp/index.ts` 中；同时历史配置默认写入 `~/.config/opencode/opencode.json`，数据库固定在 `data/db.sqlite`。因此本阶段必须把 “server 适配层”、“新工程自己的存储路径”、“最小 web 控制台与文档” 分成三个任务，确保 `mothership/` 内部保持独立。

---

### Task 0: 环境准备

**背景:**
阶段三默认依赖前两份计划已完成 Core 与 opencode plugin 的实现。这里只做轻量校验，确保 `mothership/apps/server`、`apps/web`、`plugins/opencode` 的跨包依赖在开始接路由前仍然可编译、可测试。

**执行步骤:**
- [x] 验证 `mothership` 全量类型检查命令可运行
  - 位置: `mothership/package.json` 的 `scripts.typecheck`
  - 执行 `bun run typecheck`
  - 原因: 本阶段要同时接服务端和前端，先排除跨包类型错误
- [x] 验证阶段二核心测试仍通过
  - 位置: `mothership/packages/core/src/__tests__/instance-service.test.ts` 与 `mothership/plugins/opencode/src/__tests__/acp-link-process-manager.test.ts`
  - 执行针对性 `bun test`
  - 原因: server/web 接入前先锁住 Core 与 Plugin 基线

**检查步骤:**
- [x] 检查全量类型检查可运行
  - `cd /Users/liyuan/Work/mothership-beta/mothership && bun run typecheck`
  - 预期: 命令成功结束，无 workspace 类型错误
- [x] 检查阶段二基线测试仍通过
  - `cd /Users/liyuan/Work/mothership-beta/mothership && bun test packages/core/src/__tests__/instance-service.test.ts plugins/opencode/src/__tests__/acp-link-process-manager.test.ts`
  - 预期: 两个基线测试文件全部通过

---

### Task 9: 在 `apps/server` 实现新工程的 composition layer 与兼容 API 适配

**背景:**
设计文档要求 server 只负责 HTTP/WS 路由、请求/响应映射和依赖装配，而 legacy `src/index.ts`、`src/routes/acp/index.ts` 目前直接耦合实例服务与 transport。阶段二已经有 CoreFacade 和 opencode plugin，本 Task 要把它们装进新的 server，并保持 `/web/*`、`/acp/*`、`/v1/*` 的主链路响应形状兼容。

**涉及文件:**
- 修改: `mothership/apps/server/src/app.ts`
- 修改: `mothership/apps/server/src/index.ts`
- 新建: `mothership/apps/server/src/bootstrap.ts`
- 新建: `mothership/apps/server/src/modules/environments/routes.ts`
- 新建: `mothership/apps/server/src/modules/sessions/routes.ts`
- 新建: `mothership/apps/server/src/modules/relay/routes.ts`
- 新建: `mothership/apps/server/src/modules/acp/routes.ts`
- 新建: `mothership/apps/server/src/modules/config/routes.ts`
- 新建: `mothership/apps/server/src/http/response-mappers.ts`
- 新建: `mothership/apps/server/src/__tests__/environment-routes.test.ts`
- 新建: `mothership/apps/server/src/__tests__/relay-routes.test.ts`

**执行步骤:**
- [x] 在 `bootstrap.ts` 中集中装配 CoreFacade、PluginRegistry 与 opencode plugin
  - 位置: 新文件 `mothership/apps/server/src/bootstrap.ts`
  - 创建 `createServerRuntime()`，内部实例化 repositories、`RuntimeConfigResolver`、`PluginRegistry`，注册 `createOpencodePlugin()`，最后返回 `coreFacade`
  - 原因: server 只应依赖装配结果，不应自己知道插件内部实现
- [x] 在 `modules/environments/routes.ts`、`sessions/routes.ts`、`config/routes.ts` 中实现 REST 适配层
  - 位置: 各 `routes.ts`
  - 路由层只负责参数解析、认证占位和 response mapping；返回体字段保持与 legacy 关键字段兼容，至少保留 `instance_id`、`instance_status`、`session_id`、`instances`
  - 原因: 设计文档要求迁移期不主动变更现有 `/web/*`、`/v1/*` 对外协议
- [x] 在 `modules/relay/routes.ts` 与 `modules/acp/routes.ts` 中实现 WS 入口
  - 位置: `mothership/apps/server/src/modules/relay/routes.ts`、`modules/acp/routes.ts`
  - relay 入口只把 `sessionId`、`agentId`、用户上下文交给 `coreFacade.connectRelay()`；ACP 路由只保留 provider 无关的升级、鉴权壳层，把 provider 私有 keep_alive / identify 处理交给 opencode plugin runtime
  - 原因: legacy `src/routes/acp/index.ts` 目前混合了鉴权和协议细节，这里要明确切开
- [x] 在 `response-mappers.ts` 收口 legacy 兼容字段映射
  - 位置: 新文件 `mothership/apps/server/src/http/response-mappers.ts`
  - 提供 `toEnvironmentResponse()`、`toSessionResponse()`、`toInstanceResponse()`，把 Core 领域对象转换成 legacy 控制台现有字段命名
  - 原因: 兼容层必须集中管理，避免在路由里散落重复字段映射
- [x] 更新 `app.ts` 与 `index.ts` 挂载新模块
  - 位置: `mothership/apps/server/src/app.ts`、`src/index.ts`
  - `app.ts` 负责注册 `/health`、`/web/*`、`/acp/*`、`/v1/*` 与错误处理中间件；`index.ts` 只读取配置并启动 `Bun.serve`
  - 原因: 保持 server composition layer 单职责
- [x] 为本 Task 核心逻辑编写单元测试
  - 测试文件: `mothership/apps/server/src/__tests__/environment-routes.test.ts`, `mothership/apps/server/src/__tests__/relay-routes.test.ts`
  - 测试场景:
    - `GET /web/environments`: mock facade 返回多实例 environment → 响应包含 `instance_id`、`instance_status`、`instances`
    - `POST /web/environments/:id/enter`: 指定 `instance_number` → 正确调用 facade 并返回匹配实例
    - `GET /acp/agents`: 已注册 opencode plugin → 返回 provider 元信息列表
    - relay WS: 缺少 session 或 agent 归属不匹配 → 返回错误状态，不进入插件 relay
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta/mothership && bun test apps/server/src/__tests__/environment-routes.test.ts apps/server/src/__tests__/relay-routes.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 server 装配层已隔离到 `bootstrap.ts`
  - `cd /Users/liyuan/Work/mothership-beta && rg -n "createServerRuntime|PluginRegistry|createOpencodePlugin" mothership/apps/server/src`
  - 预期: `bootstrap.ts` 统一装配 Core 与插件
- [x] 检查兼容字段映射集中定义
  - `cd /Users/liyuan/Work/mothership-beta && rg -n "instance_status|instance_id|session_id|instances" mothership/apps/server/src/http/response-mappers.ts mothership/apps/server/src/modules`
  - 预期: 字段映射逻辑集中在 `response-mappers.ts`
- [x] 检查本 Task 单测通过
  - `cd /Users/liyuan/Work/mothership-beta/mothership && bun test apps/server/src/__tests__/environment-routes.test.ts apps/server/src/__tests__/relay-routes.test.ts`
  - 预期: 两个测试文件全部通过

---

### Task 10: 实现显式存储兼容策略与持久化适配层

**背景:**
设计文档的硬约束之一是“新工程必须有自己的默认存储边界”。经代码分析确认，根工程当前默认使用 `data/db.sqlite` 与 `~/.config/opencode/opencode.json`。`mothership/apps/server` 如果继续默认落到这些路径，就无法保持独立拆分。本 Task 必须先把新工程自己的路径、数据库和配置入口落下来。

**涉及文件:**
- 新建: `mothership/apps/server/src/config/runtime-paths.ts`
- 新建: `mothership/apps/server/src/config/control-plane-config.ts`
- 新建: `mothership/apps/server/src/db/index.ts`
- 新建: `mothership/apps/server/src/db/schema.ts`
- 新建: `mothership/apps/server/src/repositories/sqlite-environment-repository.ts`
- 新建: `mothership/apps/server/src/repositories/sqlite-instance-repository.ts`
- 新建: `mothership/apps/server/src/repositories/sqlite-session-repository.ts`
- 新建: `mothership/apps/server/src/repositories/sqlite-config-repository.ts`
- 新建: `mothership/apps/server/src/__tests__/runtime-paths.test.ts`
- 新建: `mothership/apps/server/src/__tests__/sqlite-repositories.test.ts`

**执行步骤:**
- [x] 在 `runtime-paths.ts` 中定义新工程专属的默认路径
  - 位置: 新文件 `mothership/apps/server/src/config/runtime-paths.ts`
  - 默认数据库路径设为 `mothership/data/db.sqlite`，默认平台配置路径设为 `~/.config/mothership/config.json`；同时允许通过 `MOTHERSHIP_DB_PATH`、`MOTHERSHIP_CONFIG_PATH` 覆盖
  - 原因: 这是满足“禁止隐式共用 legacy 数据”的最小硬隔离
- [x] 在 `db/schema.ts` 与 `db/index.ts` 建立新工程自己的 SQLite 入口
  - 位置: `mothership/apps/server/src/db/schema.ts`、`db/index.ts`
  - 只定义新 Core 所需的 environment / instance / session / provider_session_map / config_snapshot 等表，不复用 legacy `src/db/schema.ts`
  - 原因: 新旧系统边界要体现在物理存储层，而不是只写文档
- [x] 在 `repositories/sqlite-*.ts` 实现 Core 仓储接口
  - 位置: 四个 `sqlite-*.ts`
  - 按 Task 3 的 repository contracts 分别实现 CRUD / list / mapping 查询；不要在仓储里写 provider 私有逻辑
  - 原因: server 装配层需要持久化实现才能独立运行
- [x] 在 `control-plane-config.ts` 中实现新控制面的独立配置入口
  - 位置: `mothership/apps/server/src/config/control-plane-config.ts`
  - 代码中要明确：配置只从 `MOTHERSHIP_CONFIG_PATH` 或默认 `~/.config/mothership/config.json` 读取；配置不存在时返回新控制面的默认快照
  - 原因: 新工程必须先具备完全独立的配置入口，后续才谈得上独立拆分
- [x] 为本 Task 核心逻辑编写单元测试
  - 测试文件: `mothership/apps/server/src/__tests__/runtime-paths.test.ts`, `mothership/apps/server/src/__tests__/sqlite-repositories.test.ts`
  - 测试场景:
    - `runtime-paths`: 未设置环境变量 → 返回 `mothership/data/db.sqlite` 与 `~/.config/mothership/config.json`
    - `runtime-paths`: 设置 `MOTHERSHIP_DB_PATH` / `MOTHERSHIP_CONFIG_PATH` → 返回覆盖后的路径
    - `sqlite repositories`: 保存 environment / instance / session → 可正确按 ID 和 environment 查询
    - `control-plane-config`: 配置文件存在 → 从 `MOTHERSHIP_CONFIG_PATH` 对应路径读取
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta/mothership && bun test apps/server/src/__tests__/runtime-paths.test.ts apps/server/src/__tests__/sqlite-repositories.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查默认路径不再指向 legacy 数据
  - `cd /Users/liyuan/Work/mothership-beta && rg -n "mothership/data/db\\.sqlite|~/.config/mothership/control-plane\\.json" mothership/apps/server/src/config/runtime-paths.ts`
  - 预期: 仅出现新路径，不出现 `data/db.sqlite` 或 `~/.config/opencode/opencode.json` 作为默认值
- [x] 检查控制面配置入口已独立
  - `cd /Users/liyuan/Work/mothership-beta && rg -n "MOTHERSHIP_CONFIG_PATH|config\\.json|DEFAULT_CONTROL_PLANE_CONFIG" mothership/apps/server/src/config/control-plane-config.ts mothership/apps/server/src/config/runtime-paths.ts`
  - 预期: 代码明确写出控制面自己的默认配置路径和默认快照
- [x] 检查本 Task 单测通过
  - `cd /Users/liyuan/Work/mothership-beta/mothership && bun test apps/server/src/__tests__/runtime-paths.test.ts apps/server/src/__tests__/sqlite-repositories.test.ts`
  - 预期: 两个测试文件全部通过

---

### Task 11: 建立最小 `apps/web` 控制台与插件开发文档

**背景:**
设计文档要求仓库形成 `mothership/apps/web` 结构，并在最终切换前让新前后端可独立运行；同时 phase 4 需要补 provider plugin 开发文档。本 Task 只实现最小可运行控制台和插件开发说明，不复刻 legacy 聊天交互，以避免超出当前 feature 的范围。

**涉及文件:**
- 修改: `mothership/apps/web/src/App.tsx`
- 新建: `mothership/apps/web/src/api/client.ts`
- 新建: `mothership/apps/web/src/pages/dashboard.tsx`
- 新建: `mothership/apps/web/src/components/environment-list.tsx`
- 新建: `mothership/apps/web/src/components/plugin-capability-badge.tsx`
- 新建: `mothership/apps/web/src/__tests__/dashboard.test.tsx`
- 新建: `mothership/plugins/opencode/README.md`
- 新建: `mothership/packages/plugin-sdk/README.md`

**执行步骤:**
- [x] 在 `apps/web/src/api/client.ts` 建立新控制台专用 API client
  - 位置: 新文件 `mothership/apps/web/src/api/client.ts`
  - 只封装 `GET /health`、`GET /web/environments`、`GET /acp/agents` 三类读取接口，所有请求都指向 `import.meta.env.VITE_MOTHERSHIP_BASE_URL`
  - 原因: 本阶段只需要最小控制台验证 server 可独立消费，不重写 legacy 全量交互
- [x] 在 `dashboard.tsx`、`environment-list.tsx`、`plugin-capability-badge.tsx` 实现最小控制台页面
  - 位置: 三个新文件与 `App.tsx`
  - 页面只展示 environments 列表、实例状态和插件 capability badge；保持系统字体栈，不引入外部字体资源；不要复制 legacy `web/` 复杂组件树
  - 原因: 设计文档明确“不重写前端交互逻辑”，这里以最小可运行 UI 验证新 server 链路
- [x] 在 `plugins/opencode/README.md` 与 `packages/plugin-sdk/README.md` 编写首版插件开发文档
  - 位置: 两个 README
  - `plugin-sdk/README.md` 说明 `ProviderPlugin`、`ProviderRuntimeContext`、`multiInstance` 能力声明与禁止依赖项；`plugins/opencode/README.md` 说明 `acp-link` 进程管理、`.opencode/opencode.json` 注入、relay 适配边界
  - 原因: 设计文档已将 provider plugin 开发文档列为阶段四交付物，本 feature 内先落最小版
- [x] 更新 `App.tsx` 将占位页替换为 dashboard 入口
  - 位置: `mothership/apps/web/src/App.tsx`
  - `App.tsx` 只负责渲染 dashboard 页面和基础错误态；页面加载时调用 `api/client.ts` 的读取接口
  - 原因: 让 `apps/web` 真正具备“可独立启动、可验证 server 数据”的最小价值
- [x] 为本 Task 核心逻辑编写单元测试
  - 测试文件: `mothership/apps/web/src/__tests__/dashboard.test.tsx`
  - 测试场景:
    - dashboard: mock `GET /web/environments` 返回 2 条 environment → 渲染名称、实例状态和实例数量
    - capability badge: plugin capabilities 包含 `multiInstance` → 对应标签可见
    - API 异常: client 抛错 → 页面渲染错误提示，不崩溃
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta/mothership && bun test apps/web/src/__tests__/dashboard.test.tsx`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查最小控制台页面已替换占位页
  - `cd /Users/liyuan/Work/mothership-beta && rg -n "dashboard|environment-list|plugin-capability-badge" mothership/apps/web/src`
  - 预期: `App.tsx` 与三个新增文件存在实际引用关系
- [x] 检查插件开发文档已创建
  - `cd /Users/liyuan/Work/mothership-beta && test -f mothership/plugins/opencode/README.md && test -f mothership/packages/plugin-sdk/README.md && echo ok`
  - 预期: 输出 `ok`
- [x] 检查本 Task 单测通过
  - `cd /Users/liyuan/Work/mothership-beta/mothership && bun test apps/web/src/__tests__/dashboard.test.tsx`
  - 预期: `dashboard.test.tsx` 全部通过

---

### Task 12: 总验收

**前置条件:**
- 启动命令: `cd /Users/liyuan/Work/mothership-beta/mothership && bun install`
- 测试数据准备: 无；服务端与前端均以测试桩和最小静态配置验证
- 其他环境准备: 已完成 `spec-plan-1.md`、`spec-plan-2.md` 与本文件 Task 0

**端到端验证:**

1. 运行完整测试套件确保无回归
   - `cd /Users/liyuan/Work/mothership-beta/mothership && bun test`
   - 预期: `apps/server`、`apps/web`、`packages/core`、`packages/plugin-sdk`、`plugins/opencode` 的测试全部通过
   - 失败排查: 检查三份 plan 中各 Task 的测试步骤

2. 验证新工程结构完整且与 legacy 物理隔离
   - `cd /Users/liyuan/Work/mothership-beta && find mothership -maxdepth 2 -type d | sort`
   - 预期: 输出 `apps/server`、`apps/web`、`packages/core`、`packages/plugin-sdk`、`plugins/opencode`，且 legacy `src/`、`web/` 未被纳入该目录
   - 失败排查: 检查 `spec-plan-1.md` Task 1

3. 验证 Core 与 plugin-sdk 边界清晰
   - `cd /Users/liyuan/Work/mothership-beta && rg -n "ProviderPlugin|ProviderRuntimeContext|AgentRuntimeSpec|PluginRegistry" mothership/packages mothership/plugins`
   - 预期: `packages/plugin-sdk` 承载插件契约，`packages/core` 承载运行时模型与 registry，`plugins/opencode` 只消费这些接口
   - 失败排查: 检查 `spec-plan-1.md` Task 2、Task 3，`spec-plan-2.md` Task 7

4. 验证 opencode 私有逻辑没有回流到 Core 或 server
   - `cd /Users/liyuan/Work/mothership-beta && rg -n "opencode\\.json|acp-link --host|Token:\\s*\\([a-f0-9]{64}\\)" mothership/packages/core mothership/apps/server`
   - 预期: 无匹配结果；相关实现仅存在于 `mothership/plugins/opencode`
   - 失败排查: 检查 `spec-plan-2.md` Task 6、Task 7

5. 验证兼容策略已显式定义，未隐式共用 legacy 数据
   - `cd /Users/liyuan/Work/mothership-beta && rg -n "MOTHERSHIP_DB_PATH|MOTHERSHIP_CONFIG_PATH|config\\.json|db\\.sqlite" mothership/apps/server/src`
   - 预期: 代码中能找到新工程自己的默认路径与配置入口
   - 失败排查: 检查本文件 Task 10

6. 验证新 server 与最小 web 控制台可独立构建
   - `cd /Users/liyuan/Work/mothership-beta/mothership && bun run build && bun run typecheck`
   - 预期: server/web 构建与类型检查成功，无对 legacy `src/`、`web/` 的编译依赖
   - 失败排查: 检查本文件 Task 9、Task 11
