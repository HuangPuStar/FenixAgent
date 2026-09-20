# 任务 1.5 执行计划与设计裁定：apps/server 宿主与协议聚合

本文是阶段 2 任务 1.5 的执行计划与设计裁定记录。

任务目标见[阶段 2 执行计划 §1.5](../ce-ee-refactoring-stage-2-plan.md)，权威约束见[目标架构与开发规范 §2.3](../ce-ee-engineering-standards.md)（依赖矩阵）。

**用户补充裁定（2026-09-21，任务开始前给出）**：「`/api/*` 目前还没有外部使用，接口是可以调整的（如有必要）」。本任务若需要调整 `/api/*` 的契约形状（路由归属、DTO 形状、错误信封），不必按对外兼容契约处理；`/web/*` 与协议入口沿用既有约定。

## 一、范围（计划原文四条）

1. **宿主收敛**：`apps/server` 只保留进程入口、认证 adapter、协议聚合、OpenAPI、通用错误/CORS/static/logger、环境变量、应用基础设施初始化与统一关闭编排；迁出其中的资源领域规则、具体业务 service/repository 和资源页面实现。
2. **路由 contribution**：`/web/*`、`/api/*`、ACP、MCP、Webhook、SSE、WebSocket 路由改为模块 route contribution 由宿主挂载；route 只做协议校验、认证上下文、DTO 转换、调用 Facade 与错误映射，不直接访问 DB 或调用其他 route。
3. **同一 Facade 的薄 adapter**：已发布 `/api/*`、内部 `/web/*` 和协议入口统一到同一 Facade；保持既有对外稳定合同，不形成第二套 CRUD 或业务流程。
4. **基础设施入口**：`process.env` 读取与校验、DB client 创建、模块配置拆分与进程级资源关闭集中在 `apps/server`；调用 `initializeApplicationInfrastructure()` 后，包从 `@fenix/platform-sdk/server` 读取已注册的 DB/config，不得依赖 `apps/server` 内部路径。

**与相邻任务的边界**：§1.3 已交付「资源模块的完整交付物」（路由工厂化、Facade、包内 `src/**` 只允许 `@server/db/schema` 残留）；§1.4 已交付「Agent Runtime 的三面运行契约与依赖方向」。1.5 处理的是**装配层**：谁驱动装配、路由怎么挂、宿主还剩什么。表定义迁出归 §1.7，web 页面下沉归 §1.6。

## 二、现状实测（2026-09-21，起点 `cc0925247`）

### 2.1 apps/server 规模

| 范围 | 规模 |
| --- | --- |
| `apps/server/src` 非测试 TS | **65 文件 / 7736 行** |
| ├ `db/schema.ts` | 1044 行（表定义，迁出归 §1.7） |
| ├ `main.ts` | 649 行（手写装配） |
| ├ `test-utils/**` | 5 文件 / 710 行 |
| ├ `plugins/**` | 7 文件 / 984 行（auth 450 + logger 248 + cors/error/static/system-api/require-team-scope） |
| ├ `routes/**` | 9 文件 / 1119 行（web 7 + hooks 1 + index 1） |
| ├ `services/**` | 20 文件 / 1771 行 |
| └ 顶层（`main` / `bootstrap` / `config` / `env*` / `logger` / `openapi` / `assembly-config`） | 8 文件 |
| `apps/server/src/__tests__` | 52 文件 / 8169 行 |

### 2.2 装配框架已就位，宿主未接线

`packages/platform/platform-sdk/src/assembly/` 已具备完整能力：

| 构件 | 现状 |
| --- | --- |
| `module-manifest.ts` | `ModuleManifest { id, kind, dependsOn, capabilities?, envDefinitions?, create?, contributions?, web? }`；`ModuleContribution { id, kind: "app-route" \| "protocol" \| "lifecycle", value }` |
| `module-registry.ts` | `createModuleRegistry(manifests).resolveProfile(profile)`：校验 ID/类别/依赖/capability 唯一性，按 `dependsOn` 拓扑排序；`webShell` 只校验不实例化 |
| `bootstrap.ts` | `bootstrapModules({ profile, manifests, loadEnv, preflight, mountContribution })` → `{ instances, webContributions, dispose }`；cleanup 栈按逆序幂等释放 |
| `profile.ts` | `ce.json` 的 schema：`identity` / `accessControl` / `agentRuntime` / `webShell` 必填，`resources` / `web` 为 ID 数组 |

**宿主侧未接线的证据**：`apps/server/src/bootstrap.ts` 的 `bootstrapServerAssembly()` 注释写明「当前旧服务尚未切换到该入口」；`main.ts` 全程手写装配——直接 import 16 个包（`.dependency-cruiser.cjs` 与 `handwrittenRegistryBaseline` 记录为 16 个包名）、12 处 `bind*Port(...)`、30+ 处 `.use(...)`、手工 `gracefulShutdown()` 串起 8 个包的停止函数。

### 2.3 profile 未填实

`deploy/assembly/ce.json` 当前为：

```json
{ "identity": "identity", "accessControl": "access-control", "agentRuntime": "agent-runtime",
  "webShell": "default", "resources": [], "web": [] }
```

`resources: []` 与「宿主手工装配全部资源模块」的现状不一致——profile 与 registry 此时只覆盖四个基础槽位，装配 profile 尚未成为真实装配的真相来源。`apps/generated/module-registry.ts`（生成器 `scripts/generate-module-registry.ts` 产出）已收录 16 个包 + `apps/web` 的 manifest，共 17 项。

### 2.4 门禁判据：`no-new-handwritten-registry`

`scripts/lib/architecture-boundary-rules.ts` 的这条规则**只对 `apps/server/src/main.ts` 生效**，只阻断「基线之外的包被手写挂载」，删除导入不算违规。

- 基线 `handwrittenRegistryBaseline`（`scripts/architecture/exceptions.json`）= 16 个包名，是 main.ts 当前手写 import 的**现状快照**，故意不入 `exceptions`（避免污染「不再违规即删除」的语义）。
- 规则注释写明：「1.1 只把 `ce.json` 接到生成的 registry 上，`main.ts` 的切换留给 1.5」「1.5 切到 `bootstrapServerAssembly` 后本规则连同 `handwrittenRegistryBaseline` 一并删除」。

**结论**：这条规则 + 基线字段就是 1.5 的成败判据——切换完成即两者同时删除。反之，只要 main.ts 仍手写 import 任何 `@fenix/*`，1.5 就没有交付。

### 2.5 台账（`owner: "1.5"` 6 条 + 1 条待重测）

| # | rule | 包对 | 台账记载 | 实测复核 |
| --- | --- | --- | --- | --- |
| 1 | `no-circular` | `agent-runtime → agent-runtime` | 32 处环（环长 3–9） | **14 处（环长 14–17）**，与 1.4 的 21.4 同族 |
| 2 | `no-circular` | `agent-config → agent-config` | 10 处环（环长 8–12） | **2 处（环长 14–15）** |
| 3 | `no-circular` | `knowledge → knowledge` | 2 处环（环长 2–11） | **1 处（环长 2）**——包内组合面自环，跨包那处已消失 |
| 4 | `apps-boundary` | `model-management → server-app` | 12 处 / 9 文件（6 表定义 + 4 宿主 db + 2 宿主 config） | **5 处 / 5 文件（全为 `@server/db/schema`）** |
| 5 | `apps-boundary` | `resource-mcp → server-app` | 6 处 / 6 文件（5 表定义 + 1 宿主 auth 插件） | **4 处 / 4 文件（全为 `@server/db/schema`）** |
| 6 | `apps-boundary` | `chat-channel → server-app` | 1 处 / 1 文件（宿主 `services/cache`） | **1 处 / 1 文件** ✓ 未变 |
| — | `apps-boundary`（owner 1.4） | `agent-runtime → server-app` | 6 处 / 6 文件：5 表定义 + 1 `@server/config` | 不变；其 `removeWhen` 的第二条路径点名 §1.5 |

**1–3 条的计数已过时**（环族随 1.4 的装配面收敛而重新分布，见 1.4 §21.4）；**4–5 条已缩小**（宿主 `db` / `config` / `auth` 依赖在 1.3/1.4 期间已消除，残留只剩表定义，须等 §1.7）。台账的实际剩余工作集中在三处：(a) 包不再引用 `@server/**`（表定义除外）；(b) 包 ↔ 应用倒置（包经 platform-sdk 取得宿主能力）；(c) 环族的共同闭合边（machine 方向，1.4 §21.4）。

### 2.6 包 → 宿主的依赖残留（生产代码）

| 包 | 残留 | 归属 |
| --- | --- | --- |
| `agent-runtime` | 5 处 `@server/db/schema` + 1 处 `@server/config`（`services/orchestration-instance.ts` 的 `config.defaultEngineType` / `getBaseUrl()`） | 表定义 → §1.7；`@server/config` → **1.5 的模块配置携带 baseUrl** |
| `model-management` | 5 处 `@server/db/schema` | §1.7 |
| `resource-mcp` | 4 处 `@server/db/schema` | §1.7 |
| `chat-channel` | 1 处 `@server/services/cache` 的 `getRedisConnection` | **1.5 的缓存能力下沉** |
| 其余 13 个资源包 | 仅 `@server/db/schema` | §1.7 |

测试侧：77 个包内文件引用 `@server/**`，绝大多数是 `@server/test-utils/stubs/*` 与 `@server/db/schema`（宿主测试基建的既有耦合）。

## 三、设计裁定

本节记录实施前的关键抉择。按会话约定（「遇到抉择点你自行决策然后记下来给我审核」），以下裁定由
实施方作出并在此留痕；标 **【需审核】** 的项会改变 `@fenix/platform-sdk` 的公共契约或跨包交付形状，
请在实施对应分片前确认。

### 3.1 装配主线只接管「权限装配」一段，不接管启动序

**裁定**：`bootstrapServerAssembly()` 取代 `main.ts:330-355` 的 `wirePermissions` 段
（手工 `createDrizzleAccessControl` + 4 次 `installXxxModule`），**不**接管 `initDb` 与
`initModelGateway` 两个启动阶段。

registry 承担三件事：按 profile 拓扑序实例化模块（`create`）→ create 全部完成后按序挂载贡献
（`mountContribution`）→ 用统一 cleanup 栈逆序幂等释放（`dispose`）。宿主保留
`initializeApplicationInfrastructure` 的一次性调用、`runtimeCredentialResolver` 的解析、以及
`preLaunchPorts` 的绑定。

**理由**：计划 §1.5 第 1 条把「应用基础设施初始化与统一关闭编排」留给宿主，第 4 条把
「`process.env` 读取、DB client 创建、模块配置拆分」留给宿主。`initModelGateway` 里的
`ensureSystemAdmin` / `runDataMigrations` / 沙盒崩溃恢复是宿主进程级动作，不是任何模块的贡献；
manifest 也没有字段能表达「在两个模块之间插入宿主步骤」。

**被否的备选**：让 registry 接管整段启动序。否决理由同上——把 31 条顺序约束从可读的
`await` 序列搬进声明式配置，是拿可维护性换形式统一。

### 3.2 【需审核】`ModuleFactoryContext` 增加装配声明读取面，`ModuleManifest` 增加静态绑定字段

**现状缺口**（两处包内注释已各自记录，逐字）：

- `packages/platform/access-control/fenix.module.ts`：「`createDrizzleAccessControl` 需要宿主的
  `database` 与全部资源绑定，而当前 `ModuleFactoryContext` 只提供 env 与已创建模块，无法表达这
  两者。」
- `packages/resources/mcp/src/module.ts`：「§1.5 的 registry 装配落地时应改为从 `context.modules`
  取 access-control / identity 实例并调用它。」

**裁定**：

1. `ModuleFactoryContext` 增加 `declarations: readonly ModuleManifest[]`（本次装配启用的全部
   manifest，已拓扑排序），供基础模块收集各资源模块声明的**静态**绑定。
2. `ModuleManifest` 增加可选字段 `accessControlBindings?: readonly ResourceStorageBinding[]`
   （类型已由 platform-sdk 导出），资源模块在此声明自己的 `xxxResource.storage`。
3. `database` 与 `identity` **不新增注入面**：access-control 的 create 直接调用
   `@fenix/platform-sdk/server` 已有的 `getDatabase()` / `getIdentityDirectory()`。这正是计划
   §1.5 第 4 条指定的读取路径，1.4 已在 agent-runtime 上验证过同一模式。

**为什么 bindings 走「声明」而不是「拉取」**：若让 access-control 去 `context.modules` 拉
mcp / skill / agent-config / model-management 的**实例**，则 `access-control.dependsOn` 必须含这
4 个模块，而它们又需要 access-control 提供的授权能力——形成装配环。而 `storage` 是**不依赖模块
实例化的静态导出**（现状 `main.ts:340-343` 正是在 4 次 `installXxx` 之前取它的），用声明面收集
即可打破环；这也让「先装配授权、再装配资源模块」的既有顺序在 registry 里自然成立。

**被否的备选**：把 `ResourceStorageBinding` 并入 `capabilities`。否决理由：`capabilities` 是
`readonly string[]`，module-registry 只对它做唯一性校验、没有值语义，改动它等于把「标识能力」
与「携带数据」两个正交概念合并。

### 3.3 【需审核】路由贡献的形状：`(host) => 路由实例` 的惰性构造函数

**约束推导**（三条硬约束的交集）：

1. `ModuleContribution.value` 是 manifest 上的**静态**字段，而路由实例要在运行期构造；
2. `bootstrapModules` 的 create 阶段早于 Elysia app 实例化，模块在 create 时拿不到 app；
3. `platform-sdk` 的 dependencies 只有 `zod`，其 `ModuleContribution` 注释明确「与具体 HTTP/UI
   框架解耦」——这个边界不应为了赶工而破。

**裁定**：路由贡献的 `value` 是**惰性构造函数** `(host: ServerRouteHost) => unknown`。

- `ServerRouteHost` 定义在 `@fenix/platform-sdk/server`，**所有字段类型为 `unknown`**：
  `authGuardPlugin` / `systemApiGuardPlugin` / `authenticateRequest` / `environmentLookup` /
  `userAgentPreferences` / `userModelPreferences` / `resolveSecretReference`。
  这样 platform-sdk **不新增任何依赖**，框架无关的边界完整保留。
- 各包新增 `src/server/assembly.ts`：在包内把 `ServerRouteHost` 收窄为包内既有
  `dependencies.ts` 的契约类型（一次显式收窄，附原因注释），返回构造好的路由实例。
  `fenix.module.ts` 的 `contributions` 只写一行一个引用。
- 宿主 `mountContribution` 按 `kind === "app-route"` 分派：调用 `value(host)`，把结果推入待挂载
  队列；app 构造完成后按队列顺序 `.use()`。

**时序**：`bootstrapServerAssembly()` 在 app 构造**之前**执行，`mountContribution` 只登记不挂载；
挂载统一在 app 构造后、`app.listen()` 前完成——与现状「app 构造时逐个 `.use()`」在 Elysia 看来
等价（都在 listen 之前完成注册）。

**`ModuleContribution` 增加可选 `order?: number`**（默认 0，bootstrap 按 `order` 稳定排序，同值
保持拓扑序）。现状 `createAgentSitesCompatRoutes` 必须最后注册（`main.ts:575-576` 注释），
它声明大 `order` 即可，宿主不需要维护「必须最后」的模块清单。

**被否的备选**：

- 让 `ServerRouteHost` 直接引用 Elysia 类型。否决理由：会给 platform-sdk 引入 `elysia`
  依赖（哪怕只是 `import type`），与既有解耦注释冲突；而收益只是省掉每包一次收窄。
- 宿主维护「模块 ID → 依赖」映射来调用路由工厂。否决理由：这正是
  `no-new-handwritten-registry` 要根除的手写映射，换个位置写而已。
- 让模块把路由挂到模块实例上、宿主读 `instance.routes`。否决理由：这要求 platform-sdk 定义
  「模块实例的统一形状」，而 `contributions` 字段在 1.1 已经为同一目的定型，等于并行造第二套。

### 3.4 宿主保留面按「进程语义」划线，不按「文件位置」划线

**裁定**：以下留在 `apps/server`——进程入口与装配（`main` / `bootstrap` / `assembly-config` /
`bootstrap/*`）、环境与基础设施（`env` / `env-loader` / `config` / `db`）、认证 adapter
（`plugins/auth` / `plugins/system-api-auth` / `services/org-context`）、通用中间件
（`plugins/{cors,error-handler,logger,static}`）、协议聚合（`routes/web/index` 与
`routes/web/config/index`）、宿主端口适配（`services/resource-module-ports` /
`pre-launch-ports` / `model-gateway-subject-verification`）、跨包启动编排
（`services/sync-builtin`）、进程级单例（`services/cache`）、OpenAPI 与健康信息。

**理由**：规划 §1.5 首句列出的保留项全部是「只有宿主进程能提供」的东西——它是唯一同时持有
进程 env、DB 连接与应用生命周期的一层。**判据是「这一段是否只能在进程入口处完成」，不是
「它是否看起来像基础设施」。**

**唯一需要改的是 `services/cache.ts`**：文件留在宿主，但它的读取面要注册进
`@fenix/platform-sdk/server`，供 `packages/chat-channel` 取用（见 3.5）。

### 3.5 包 → 宿主的两条生产残留边在 1.5 内切断

| 残留 | 处置 |
| --- | --- |
| `chat-channel/src/server/services/doc-manager-instance.ts:4` 的 `@server/services/cache` | 宿主把 `getRedisConnection` 注册进 `@fenix/platform-sdk/server` 的进程能力面（与 `getDatabase` 同构），包改从 platform-sdk 取。台账第 6 条随之销账。 |
| `agent-runtime/src/services/orchestration-instance.ts:18` 的 `@server/config`（`config.defaultEngineType` / `getBaseUrl()`） | 改由**模块配置**携带（`getModuleConfig("agent-runtime")`），宿主在 `initializeApplicationInfrastructure` 的 `moduleConfigs` 里补这两个键。这与 1.3 已建立的「配置经模块配置注入、包侧不读 `process.env`」完全同构，不新增机制。 |

`@server/plugins/auth` 的 28 处命中需逐条甄别：按 `routes/web/index.ts` 的既有约定，守卫一律是
**工厂注入**而非深链导入，预计绝大多数是注释与类型引用；若存在真实深链，属工厂化未完成，按偏离
既有合同处理。

### 3.6 两处归属存疑文件的裁定

- **`services/branding.ts` + `routes/web/branding.ts` + `schemas/branding.schema.ts`：宿主保留。**
  D4 决策已把它判为「控制台壳职责而非身份职责」，与当前实现一致；值全部来自已校验 env
  （`APP_BRAND_NAME` / `APP_LOGO_PATH`），无领域规则。§1.3「发现未归属能力按其真实领域补入
  owner」针对的是**领域能力**，品牌展示是壳配置，不构成反例。
- **`services/automationState.ts` + `types/api.ts`：删除。** 两个文件的生产消费方只有彼此，全仓
  无任何写入方（`sleep_until` / `next_tick_at` / `standby` 只出现在这两处与前端一个
  `automation_state?: unknown` 可选字段里），会话/环境类型已被包内 schema 取代。按「删除优于
  兼容」处置。**此项标注为待确认删除**：若产品侧确认该会话投影仍在使用，恢复方式是从
  `@fenix/agent-runtime` 的会话契约重新导出，而不是保留宿主副本。

### 3.7 分片节奏

按用户的既有指令「每个子任务完成建议先提交，再下一子任务」，每个分片独立提交、独立跑
`precheck`。

## 四、分片

依赖关系：`1.5d` 是 `1.5e` / `1.5f` 的前置；`1.5a` / `1.5b` / `1.5c` 互相独立，可先做。

| 分片 | 内容 | 判据 | 前置 |
| --- | --- | --- | --- |
| **1.5a** | 宿主死代码清理：删除 `repositories/index.ts`、`schemas/index.ts`（160 行无引用 barrel）、`transport/ws-types.ts`、`utils/executable.ts`、`logger.ts`（兼容桥）、`types/messages.ts`、`plugins/require-team-scope.ts`、`services/config/jsonb.ts`、`services/config/index.ts`、`schemas/sidebar-config.schema.ts`（与包内重复）、`services/config-utils.ts` 的信封函数（`resolveApiKey` 保留）、`services/config/mcp-system-server.ts`（零消费方薄包装）；`services/config/types.ts` 按 3.4 拆分 | 删除后 `precheck` 全绿；每项删除均有「零生产消费方」证据 | — |
| **1.5b** | 包 → 宿主残留边：`services/cache` 读取面注册进 platform-sdk；`agent-runtime` 的 `@server/config` 改走模块配置；`@server/plugins/auth` 28 处逐条甄别并清零真实深链 | `grep '@server/' packages/**/src`（排除 `db/schema`）生产命中归零 | — |
| **1.5c** | 宿主业务面迁出：`routes/web/{environments,instances,control}.ts` + `schemas/session.schema.ts` + `services/transport.ts` → `@fenix/agent-runtime`；`routes/web/peri-task-details.ts` + `schemas/peri-task-details.ts` → `@fenix/model-management`；`routes/web/meta-agent.ts` → `@fenix/agent-config`；`routes/hooks.ts` → `@fenix/resource-workflow`；`services/config/user-config.ts` → `@fenix/identity`；`services/core-bootstrap.ts` 按 3.4 拆分（`ensureMachineExists` → machine，实例注册表 → agent-runtime） | 迁出后各包测试通过；宿主不再 import 这些实现 | — |
| **1.5d** | 【需审核】platform-sdk 契约扩展：`ModuleFactoryContext.declarations`、`ModuleManifest.accessControlBindings`、`ModuleContribution.order`、`ServerRouteHost` 与宿主协议 adapter 面；access-control / mcp / skill / agent-config / model-management 的 `create` 改为接收声明并去掉「已知不足」注释 | `bootstrap.test.ts` 扩测新契约；`access-control` 与 mcp 的 create 返回真实例而非命名空间 | — |
| **1.5e** | 路由 contributions 声明：**先试点 `prod-view`**（2 个 web 路由、叶子模块、已在包内），打通「包声明 → 宿主挂载」端到端；再逐包铺开其余 12 个有路由的包 | 每个包的 `routes/web/index.ts` 挂载点减少一处；试点片后 `precheck` + 手工启动验证 | 1.5d |
| **1.5f** | `main.ts` 切换到 `bootstrapServerAssembly`，删除全部 `@fenix/*` 手写 import；删除 `no-new-handwritten-registry` 规则与 `handwrittenRegistryBaseline`；填实 `deploy/assembly/ce.json` 的 `resources` | **本任务的成败判据**：`grep '@fenix/' apps/server/src/main.ts` 归零；门禁规则与基线字段同时消失；服务可启动 | 1.5e |
| **1.5g** | 1.5 名下台账据实改写（3 条 `no-circular` 计数、3 条 `apps-boundary`）并复核 1.4 名下的 `agent-runtime → server-app` | 台账计数与门禁实测一致 | 1.5f |

**本任务不做**（留给后续任务）：表定义迁出（§1.7）、web 页面下沉与 WebShell 装配（§1.6）、
envDefinitions 与 preflight 收敛（§1.7）、模块配置读取面彻底收敛（§1.7）。

## 五、验收与证据

1. **门禁判据**：`no-new-handwritten-registry` 规则与 `handwrittenRegistryBaseline` 已删除，且
   `apps/server/src/main.ts` 不含任何 `@fenix/*` import。
2. **装配自洽**：`module-assembly.test.ts` 用真实 `deploy/assembly/ce.json` + 生成的 registry 验证
   全部启用模块可解析、可实例化、可逆序释放；`resources` 已由 profile 真实驱动。
3. **依赖收口**：包内 `src/**` 生产代码对 `@server/**` 的导入只剩 `@server/db/schema`（§1.7 残留），
   无 `@server/config`、`@server/services/*`、`@server/plugins/*`。
4. **宿主收敛**：3.4 表列出的保留面之外无业务实现；`apps/server/src` 非测试行数相对起点
   7736 行的净减少量与 1.5a/1.5c 的删除/迁出清单可对账。
5. **全量验证**：`bun run precheck`（`env -u ANTHROPIC_MODEL`）、`bun run build:web`、
   `bun run docs:build` 三项全绿；服务可 `bun run dev` 启动并通过 `/health`。
6. **台账**：1.5 名下 6 条据实改写，销账项标注删除条件与实际证据。

## 六、遗留与风险

- **路由挂载顺序**：现状 26 个 `.use()` 的顺序由手写序列固定；改由拓扑序 + `order` 表达后，
  通配符路由（`/app-xxx/*` 兜底、`/web/site/deploy/:appId/*` 代理）的相对优先级需在 1.5e 试点与
  1.5f 切换后实测确认。Elysia 使用 radix tree 匹配，静态段优先于动态段，与注册顺序关系有限，
  但兜底通配符必须实测。
- **`@server/plugins/auth` 的 28 处命中**尚未逐条甄别，1.5b 内完成；若出现真实深链，需要补做
  守卫工厂化，可能撑大 1.5b 的范围。
- **`automationState.ts` 的删除**为待确认项（见 3.6）。
- **悬空引用**：多条台账 rationale 引用的
  `docs/design/ce-ee-refactoring/review/1.1-warehouse-boundary.md` 不存在，1.5g 一并处理
  （改为指向真实存在的文档或删除该论据）。
- **`@server/db/schema` 的 114 处生产命中**不在本任务范围（§1.7），1.5 只能保证不新增。

## 七、交付记录

### 1.5a 宿主死代码清理（2026-09-21）

**删除清单（15 个文件，每项均经「零生产消费方」独立核验）**：

| 文件 | 核验证据 |
| --- | --- |
| `logger.ts` | `@fenix/logger` 的兼容桥，仓内零 import（`import { logError } from "./logger"` 解析到 `plugins/logger.ts`，非本文件）；文件自述「新代码请直接使用 `@fenix/logger`」 |
| `plugins/require-team-scope.ts` + `__tests__/require-team-scope.test.ts` | 生产零消费方；组织范围判定已由 `@fenix/access-control` + Resource Facade 承担 |
| `utils/executable.ts` + `__tests__/executable.test.ts` | 宿主版零生产消费方；`acp-link/src/client/resolve-executable.ts` 与 `plugin-{ccb,opencode}/src/process/executable.ts` 各有实现 |
| `services/config/jsonb.ts` + `__tests__/jsonb-utils.test.ts` | `parseJsonb` / `parseJsonbOr` 生产零消费方；`mcp` 包内已有同因实现 |
| `schemas/index.ts` | 160 行纯转发 barrel，全仓零 import（含 `../schemas` 与 `@server/schemas` 两种形式） |
| `schemas/sidebar-config.schema.ts` | owner 是 `@fenix/agent-config`；宿主这份的唯一引用就是上面那个 barrel |
| `transport/ws-types.ts` | 零消费方；machine 与 agent-runtime 各自自持同名类型并已在包内写明取代理由 |
| `types/messages.ts` | 全仓零 import |
| `repositories/index.ts` | 全仓无 `@server/repositories` 消费方，仅 `setup-mocks.ts` 一处历史注释提及 |
| `services/automationState.ts` + `types/api.ts` + `__tests__/automationState.test.ts` | 两份互相引用形成孤岛，`automation_state` 全仓无写入方（裁定见 §3.6） |

**同步更新的既有台账（两处，均属「删除即销账」的既有惯例）**：

- `scripts/__tests__/rmd-07-migration.test.ts`：`RMD_07_MOVES` 移出 9 个源文件项 + 3 个测试项，长度
  62 → 50，并在既有注释块末尾补记本批的逐项删除理由。
- `scripts/root-source-owner-rules.ts`：`RETAINED_HOST_TEST_RATIONALES` 移除随删除消失的 3 条
  （`automationState` / `executable` / `jsonb-utils`）。

**本轮未动**（登记理由，避免后续误判为遗漏）：

- `services/config/mcp-system-server.ts`：它是「宿主对系统初始化路径的唯一出口」，但对应的
  `RegisterSystemMcpServer` 端口从未被注入（`ensureHindsightMcpServer` 全仓仅测试调用）。这条
  Hindsight 路径未接线，是迁入 memory 包还是删除需要更多判断，留给 1.5c。
- `services/config-utils.ts` 的信封函数：删除需要同步调整 `resource-module-ports.ts` 的 import，
  与 1.5c 的端口收敛同批处理更安全。

**验证证据**：

- `precheck` 第二次运行全绿：`All passed (109653ms)`，其中 package-tests 48091ms / 7228 pass /
  0 fail。
- **一次非确定性失败的记录**：首次运行 `package-tests` 报
  `packages/chat-channel/src/channel/gateway-shared-relay.test.ts` 单项耗时 898839ms 后失败，
  整个 package-tests 从基线 58.6s 涨到 902s。该文件单独复跑为 **11 pass / 0 fail / 6.72s**，
  重跑全量亦通过。判定为并发环境下的偶发卡死：与本批删除无依赖交集（被删文件全部在
  `apps/server`，该测试属 `chat-channel`），且同批的 `tsc (server)`、`architecture`、
  `dependency-boundaries` 三项均通过。

### 1.5b 勘察结论（实施前更新）

- **`@server/plugins/auth` 的真实深链为 0**：全仓只有 2 处 import，均为宿主自身测试引用
  `setTestAuth` / `resetTestAuth`（宿主测试工具，合法）；其余 28 处命中全部是解释「守卫改为工厂
  注入」的注释。§六 中「需逐条甄别、可能撑大范围」的风险据此消除。
- **缓存下沉的落点已确认**：`packages/platform/platform-sdk/src/server.ts` 的既有惯例
  （`registerIdentityDirectory` + `unknown` 存储槽、读取时收窄为契约类型）正是模板。注意语义与
  `getDatabase` 不同——无 `RCS_REDIS_URL` 时 Redis 连接合法地为 `null`，且 `cache.ts` 是**惰性**
  建连（首次 `getCache()` 时才赋值 `_redis`），因此注册面必须存 **provider 函数**而非值快照。
- **`agent-runtime` 的 `@server/config` 只剩两个键**：`config.defaultEngineType`（:127）与
  `getBaseUrl()`（:453，注入 `USER_META_BASE_URL`）。包内 `src/server/config.ts` 的
  `AgentRuntimeModuleConfig` 已提供 `getModuleConfig("agent-runtime")` 读取面，只需补这两个字段与
  对应 schema 条目，宿主 `main.ts` 的模块配置同步补键。
