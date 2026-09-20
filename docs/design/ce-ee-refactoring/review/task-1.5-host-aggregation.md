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
| `chat-channel/src/server/services/doc-manager-instance.ts:4` 的 `@server/services/cache` | 宿主把 `getRedisConnection` 注册进 `@fenix/platform-sdk/server` 的进程能力面（与 `getDatabase` 同构），包改从 platform-sdk 取。台账第 6 条随之销账。**实施时的口径调整见 §七 1.5b 三**：落点改为 `initializeApplicationInfrastructure` 的必填输入，并借此收敛掉 `agent-runtime` 在 1.4 W2 建的同类包级 port。 |
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

### 1.5b 包 → 宿主残留边切断（2026-09-21，实施后）

**一、`agent-runtime` 的 `@server/config`（2 个键）**

| 改动 | 文件 |
| --- | --- |
| 模块配置补 `defaultEngineType?` / `baseUrl` 两字段与 schema 条目；头注释由「两类」改「三类」并写明这两个键的来历 | `packages/agent-runtime/src/server/config.ts` |
| import 改走 `getAgentRuntimeConfig()`，两处取值与两处注释同步 | `packages/agent-runtime/src/services/orchestration-instance.ts` |
| 测试装配基线补 `baseUrl: "http://stub.invalid"`（`baseUrl` 是新增必填键，不补会让所有走该辅助的包内用例在 `safeParse` 处抛错） | `packages/agent-runtime/src/server/testing.ts` |
| 模块配置注入这两个键 | `apps/server/src/main.ts` |

**二、删除 `packages/agent-runtime/src/__tests__/instance-machine-fallback.test.ts`（10 个用例）**

逐条读完全文后的定性：

- **3 例**测的是宿主 `setConfig` / `config` 的读写（其中 4 处带 `as any`），被测对象是宿主的测试辅助函数
  而非本包生产代码；对应的 env 校验（`RCS_DEFAULT_MACHINE_ID` / `RCS_DEFAULT_ENGINE_TYPE`）已由宿主
  `apps/server/src/__tests__/env-validation.test.ts:79-106` 覆盖。
- **4 例是自证式**：把生产表达式抄进测试再断言自己（其中 `:61-62` 还把 `config.defaultMachineId` 误当作
  `resolvedNodeId`），删掉生产实现它们照样通过。
- **3 例是纯局部变量 if/else**，连生产模块都不 import。
- 真正的语义由走生产代码的用例覆盖：local-default 分支的引擎透传见
  `orchestration-instance-nodeid.test.ts:132`；`agent_config.machineId` → 兜底机器 → `local-default` 的
  fallback 链见 `environment-orchestration.test.ts`（13 例，经 `stubAgentRuntimeConfig` 驱动生产读取路径）。
- 该文件同时是本包**测试侧**对 `@server/config` 的最后一处引用，删除后包内真实 import 命中归零。

同批改造 `orchestration-instance-nodeid.test.ts`：`:88` 的 `setConfig({ defaultEngineType: undefined })` 删除
（缺省基线即 `undefined`）、`:133` 改用 `stubAgentRuntimeConfig`、`:42`/`:102` 的 config 快照与恢复逻辑移除。

**三、Redis 读取面收敛（口径调整，需审核）**

§3.5 原计划是「宿主把 `getRedisConnection` 注册进 platform-sdk 的进程能力面」。实施中发现**第二个真实
用例已存在**：`agent-runtime` 在 1.4 W2 已为 YJS 会话快照建了包级 port
（`src/server/services/redis-connection-port.ts` 的 `bindRedisConnectionPort` / `getBoundRedisConnection`），
由宿主 `main.ts:305` 绑定。两个消费方（`chat-channel` 的 DocManager、`agent-runtime` 的会话切换快照）读的
是同一个部署值，而 `chat-channel` **不能依赖 `agent-runtime`**（依赖方向不允许），包级 port 因此无法被复用
——若照原计划新增第三个读取面，会形成「同一部署值三处取数点」。

据此把实现从「新增读取面」改为「收敛到唯一读取面」：

| 改动 | 文件 |
| --- | --- |
| 新增**必填**输入 `redisConnection: (() => unknown) \| null` 与读取面 `getRedisConnection<TRedis>(): TRedis \| null` | `packages/platform/platform-sdk/src/server.ts` |
| 测试装配透传（缺省 `null`，与迁移前测试进程行为逐字一致） | `packages/platform/platform-sdk/src/testing/test-application-infrastructure.ts` |
| 声明生产 provider `() => getRedisConnection()`；删除 `bindRedisConnectionPort` 调用与 import | `apps/server/src/main.ts` |
| `mock.module` seam 加同名回退（实现与原 `bindRedisConnectionPort` 的替身逐字等价） | `apps/server/src/test-utils/setup-mocks.ts` |
| 删除包级 port 文件与它在 `@fenix/agent-runtime/server` 的出口；`chat-channel-bootstrap.ts` 改读 platform-sdk | `packages/agent-runtime/src/server/services/redis-connection-port.ts`（删除）、`src/server.ts`、`src/server/services/chat-channel-bootstrap.ts` |
| 改读 platform-sdk | `packages/chat-channel/src/server/services/doc-manager-instance.ts` |

**必填而非可选是该设计的要点**：选填会让「装配漏传」与「本进程声明不用 Redis」不可区分——配了
`RCS_REDIS_URL` 的部署会静默退化成进程内缓存，多实例之间的 Y.Doc 快照不再共享且没有任何报错。改成必填
后，漏传是编译期错误；这正是它可以取代 1.4 W2 那条「未装配即抛错」运行期检查的原因，语义不退化。
`getRedisConnection()` 未初始化时仍抛错（走 `requireInfrastructure()`），所以未初始化态也没被放过。

**须审核项：这删除了 `@fenix/agent-runtime/server` 的 4 个导出（含 `RedisConnectionProvider` 类型），是
公共契约变化，且推翻了 1.4 W2 的产出。** 判定依据是 §九「删除优于兼容」与 §2.3「不得并行创建第二套能力」：
保留两条读取面读同一个 `cache.ts` 才是更差的终局。若审核不通过，回退点是「恢复 port、platform-sdk 的面只
供 chat-channel 使用」。

**四、台账销账**

`scripts/architecture/exceptions.json` 删除 `apps-boundary @fenix/chat-channel @fenix/server-app`（owner
`1.5`；其 rationale 原文即写明「缓存能力收敛到 platform-sdk 后本边消失，属 1.5 范围」）。删除前
`architecture` 门禁报「有 1 条已不再违规，必须删除」，删除后转绿——**这是本次改动生效的正面信号**。

`apps-boundary @fenix/agent-runtime @fenix/server-app`（owner `1.4`）**仍然有效**：该包残留已只剩
`@server/db/schema`（5 处，归 §1.7）。owner 同为 `1.5` 的 `model-management` / `resource-mcp` 两条边属
1.5c（宿主业务面迁出），本分片不涉及。

**五、两处已知边界（记录，不修）**

- `setup-mocks.ts` 的 Redis 回退 seam 使 `server-infrastructure.test.ts` 里「未初始化时读取 Redis 必须抛错」
  这条契约**结构性不可断言**（实测读到的是替身回退值 `null`，而非错误）。已移除该断言并在文件中写明原因；
  契约本身由与被保留的两条断言同一条 `requireInfrastructure()` 路径保证。这与该文件既有的「宿主 preload
  会把已登记模块的读取回退到基线」是同一类现象。
- `cache.ts` 的 `getRedisConnection()` 不触发建连（`_redis` 只在首次 `getCache()` 后非 null）。既有行为，
  本次逐字保留；传 provider 而非值快照正是为了让宿主建连后的新连接可被读到，`server-infrastructure.test.ts`
  新增用例锁定这一点。

**验证证据**：`precheck` 全绿 `All passed (98993ms)`——server-and-script-tests 863 pass / package-tests
7219 pass / web-app-tests 946 pass / 0 fail；`architecture`、`dependency-boundaries`、三项 `tsc` 均通过。
分项：`platform-sdk` 8 pass、`chat-channel` 653 pass（30 文件）、`agent-runtime` 330 pass（50 文件）、
`round29-cache-isolation` 68 pass。

### 1.5c-1 Webhook 入口迁出 + 修复丢失的挂载（2026-09-21）

**一、迁出与落点**

| 改动 | 文件 |
| --- | --- |
| 新建路由工厂 `createHookRoutes()`（无 deps，见下） | `packages/resources/workflow/src/server/routes/hooks/index.ts` |
| `@fenix/resource-workflow/server` 增加出口 | `packages/resources/workflow/src/server.ts` |
| 删除宿主副本（56 行） | `apps/server/src/routes/hooks.ts`（删除） |
| 挂载点插在 `knowledgeMcpRoutes` 与 `createAcpRoutes` 之间（与原入口顺序一致） | `apps/server/src/main.ts` |

**工厂不接收守卫依赖**：无认证是这个端点的**协议语义**（trigger 的 `publicHash` 即凭据），不是「守卫尚未
注入」。这与 §3.5 所论的「守卫必须由宿主注入」不冲突——那条约束管的是**需要**认证的 `/web/*` 与 `/api/*`；
本端点唯一用到的宿主能力是 HTTP 边缘本身，`handleWebhookRequest` 与 trigger 仓储本来就在包内，因此没有
`WorkflowRouteDependencies` 参数。

**二、目录形状（由门禁反馈定案）**

首次落点是 `routes/hooks.ts`（与 `dependencies.ts` 同级）。`precheck` 第一次运行即失败：

```
✗ package-tests  packages/resources/workflow/src/__tests__/workflow-source-migration.test.ts:314
  路由文件只出现在 routes/web 与 routes/api 下  →  ["src/server/routes/hooks.ts"]
```

该断言是 workflow 包自有的布局契约（任务 1.3 §1），意在「其余深度意味着还留着旧布局的第二套入口」。
裁定：**登记第三个协议前缀 `hooks/`，落点为 `routes/hooks/index.ts`**，而不是放宽成「允许 routes 根下的
散文件」（那会削弱规则本身）。依据是仓内已有同类先例——`packages/agent-runtime/src/routes/acp/index.ts`
同为「协议前缀目录 + index」的形态；Webhook 与 ACP、MCP 同属独立协议面，既非控制台 `/web/*` 也非对外
`/api/*`（CLAUDE.md「内部协议能力使用独立前缀，不得混入 `/web` 或 `/api`」）。测试的正则由 `^(web|api)/`
改 `^(web|api|hooks)/` 并写明「加前缀必须在此登记，等同于一次布局评审」。

**三、迁出时发现并修复的既有缺陷：`/hooks/:publicHash` 自 FND-05 起不可达**

- **根因**：该端点由提交 `38bc236f0` 引入，`.use(hooksRoutes)` 挂在当时的入口 `src/index.ts` 上。FND-05
  （`a22fc214a`「迁移 FND-05 应用入口至 apps」）把入口整体挪到 `apps/server/src/main.ts` 并删除旧入口，
  挂载没有跟着带过去。证据：`git log -S 'hooksRoutes' -- apps/server/src/main.ts` **空结果**（新入口从未
  挂载过它），而 `git log --diff-filter=D -- src/index.ts` 唯一命中 `a22fc214a`。
- **影响**：`services/workflow-trigger.ts:44` 的 `buildWebhookUrl()` 会产出 `${baseUrl}/hooks/${publicHash}`，
  并在 trigger 的 create / regenerate 响应里作为 `webhookUrl` 对外返回——即**平台把一条 404 的地址展示给
  用户**，Webhook 触发能力自 FND-05 起实质不可用。属「迁移丢挂载」而非设计变更：本包 `fenix.module.ts`
  与 README 一直把 Webhook 列为交付面。
- **修复与迁出合一**：路由落回 owner 包的同时在 `main.ts` 按原顺序恢复 `.use(createHookRoutes())`，并补
  4 个路由契约用例锁定行为（见下）。这是「修复与迁移同批做」的边界内动作，未扩展到其他协议面。

**四、测试**（`packages/resources/workflow/src/__tests__/hooks-routes.test.ts`，4 例）

未知 `publicHash` → 404 `{error:"trigger not found"}`；已禁用 trigger → **同一** 404 响应（否则穷举 hash
即可探测 trigger 存在性）；声明超过 1MB 的 `content-length` → 413；命中已启用 trigger → 立即 200
`{received:true}`（触发是 fire-and-forget）。`stubDb` 提供 `select().from().where().limit()` 队列替身。

一处测试口径需记录：内存构造的 `Request` 不带 `content-length`（实测为 `null`，真实部署下该头由 HTTP
传输层按实际 body 写入），因此 413 用例**显式声明**该头并配小 body，文件内已注明两者在边缘层等价。

**五、台账同步**

- `scripts/__tests__/rmd-07-migration.test.ts`：`src/routes/hooks.ts` 从 `RMD_07_MOVES` 移入
  `RMD_07_RELOCATED` 三元组（长度 50 → 49、6 → 7），两处注释块补记理由，relocated 用例标题加入 webhook。
- `packages/resources/workflow/fenix.module.ts`：描述符注释的交付面加入 `createHookRoutes`，消费者列表
  去掉已迁出的宿主路径。
- `scripts/root-source-owner-rules.ts:809` 的 `src/routes/hooks.ts` 规则**保留不动**：它按**根目录** `src/`
  逐文件审计（该路径在 RMD-07 之前就已不存在于根），与宿主 `apps/server/src/routes/hooks.ts` 的删除无关；
  本轮不属该清单的改动范围。

**验证证据**：`precheck` 全绿 `All passed (99339ms)`——server-and-script-tests 863 pass / package-tests
7223 pass / web-app-tests 946 pass / 0 fail；`architecture`、`dependency-boundaries`、`module-registry`、
三项 `tsc` 均通过。定向运行 `workflow-source-migration` + `hooks-routes` + `rmd-07-migration` 共 21 pass。

### 1.5c-2 控制面三件套迁入 agent-runtime（2026-09-21）

**一、迁出与落点**（§四 分片表的 control 三件套）

| 改动 | 文件 |
| --- | --- |
| 会话协议模型（内容逐字保留，仅新增头注释） | `apps/server/src/schemas/session.schema.ts` → `packages/agent-runtime/src/schemas/session.schema.ts` |
| 会话事件规范化与发布，迁入后改名 `session-events` | `apps/server/src/services/transport.ts` → `packages/agent-runtime/src/transport/session-events.ts` |
| 其边界用例（仅改 import 目标） | `apps/server/src/__tests__/transport-normalize.test.ts` → `packages/agent-runtime/src/__tests__/transport-normalize.test.ts` |
| 新建路由工厂 `createWebControlRoutes(deps)` | `packages/agent-runtime/src/routes/web/control.ts` |
| 删除宿主副本（256 行） | `apps/server/src/routes/web/control.ts`（删除） |
| `@fenix/agent-runtime/server` 增加出口 | `packages/agent-runtime/src/server.ts` |
| 宿主改为工厂注入 | `apps/server/src/routes/web/index.ts` |

**改名理由**：原名 `transport` 在宿主语境下可读，但本包已有 `src/transport/` 目录，且该目录里
`event-bus.ts` 才是传输原语本身；本文件职责是「把上游载荷规范化后发布到会话总线」，故定名
`session-events`，与新落点同目录。

**二、【需审核】`control.ts` 的归属在 1.2 → 1.5c 之间改判了两次**

1.2 记录（`review/task-1.2-platform-identity-authorization.md` §实施、`rmd-06` 文档注释、
`root-source-owner-rules.ts` 的 `TARGET_PREFIX_OVERRIDES`）给出的裁定是「**必须留在宿主**」，理由唯一：
它同时依赖 Agent Runtime 的会话服务与 Machine 的事件服务，放进任一模块都会与既有的
`resource-machine → agent-runtime` 成环，只有宿主能同时持有两侧。

**这条前提已在本轮之前消失**：1.4 W6b 把 EventBus 与 `environmentRepo` 收敛回 agent-runtime（Machine
的同名薄封装删除，见 `review/task-1.4-agent-runtime.md` W6b 记录）。迁入前逐行核对，本路由没有任何一处
跨领域依赖——会话事件与状态（`services/session`）、实例归属（`agentInstanceService`）、环境组织归属
（`environmentRepo`）三件事的 owner 全在本包。据此按 §四 分片表迁入，1.2 的三处记录同步改写为
「1.2 暂落宿主、1.5c 按分片表迁回 agent-runtime」。

**取数方式的调整**：包内路由一律直接相对引用实现，**不经** `getBoundAgentRuntime()`。后者是**宿主**
装配完成的判据，包内路由走它等于自引用本包入口；包内既有惯例（`routes/api/instances.ts`、
`routes/acp/index.ts`）同样是直引实现。

**三、【需审核】迁出时发现并修复的既有契约缺陷：控制面成功路径固定返回 422**

- **现象**：`/web/sessions/:id/events` 与 `/web/sessions/:id/control` 的成功路径响应校验失败，实测响应体
  `{"type":"validation","on":"response","property":"data",...}`。
- **根因**：响应 schema 声明的字段是 `timestamp`（`SessionEventSchema`，见迁移后的
  `packages/agent-runtime/src/schemas/session.schema.ts`），而事件总线产出的是 `createdAt`（`SessionEvent`
  定义在冻结文件 `transport/event-bus.ts`）。两者同名不同义，handler 直传总线对象必然不满足 schema。
- **影响面**：仓内**零消费方**（前端不调用 `/web/sessions/*`，该前缀本就无实现配套），因此不存在对外
  兼容包袱；但这是与迁出无关的既有缺陷，按红线「发现即处理」在此修复。
- **修复**：新增边界投影 `toSessionEventView(event)`，把 `createdAt` 映射为 `timestamp` 后返回；两条端点
  的成功分支改用它。选择显式投影而非「回传总线对象 + 靠 schema 剔除」，是因为落盘的线上形状应当就是
  schema 本身。用例已用 `expect(typeof body.data.event.timestamp).toBe("number")` 锁定。
- **回退点**：若审核认为应保留 422 这一既有行为，把 `toSessionEventView` 调用换回直传 `event` 并同步该
  断言即可；`interrupt` 端点未受影响（返回 `WebOkSchema(z.null())`）。

**四、死协议模型登记**：`session.schema.ts` 的 `SessionDetail` / `SessionListItem` / `SessionHistory` 三组
模型对应的 `/web/sessions`、`/web/sessions/:id`、`/web/sessions/:id/history` **从未实现**、全仓零消费者。
迁入时原样保留（本分片只做归属调整，不做协议清理），并在文件头注释登记为后续收口候选；真正被消费的只有
`SessionEventPayloadSchema` 与 `SendEventResponseSchema`。

**五、测试**（`packages/agent-runtime/src/__tests__/web-control-routes.test.ts`，8 例）

未认证 → 401；总线无会话 → 404（不区分「从未存在」与「已结束」，避免用返回码探测会话）；实例不属于该
用户 → 403；环境组织与请求上下文不一致 → 403 `Not your organization's session`；成功发事件 → 200 +
`timestamp` 为数字 + `payload.content` 已规范化 + 事件确实进总线；`/control` 缺省类型
`control_request`；`/interrupt` 返回 `{success:true,data:null}` 且总线事件序列为
`["interrupt","session_status"]`；无组织归属的环境仍可命中（同用户边界）。

一处测试基建口径需记录：归属校验要读两份数据，替身来源不同。实例归属走真实仓储
（`agentInstanceService.getOwnedInstance` → `db.select()...limit()`），用 `stubDb` 队列给行；环境归属走
`environmentRepo.getById`，而该模块被**宿主 preload**（`apps/server/src/test-utils/setup-mocks.ts`）的
`mock.module` 换成实时转发 Proxy，默认 `{ getById: async () => null }`，因此包内用例只能经它的登记替身
`stubEnvironmentRepo` 设置（与 `api-instance-routes.test.ts` 用 `stubCoreBootstrap` 同例）。首轮 5 个
用例因此全数 403，本文件头注释已写明两条替身路径的差别。

**六、台账同步**

- `scripts/__tests__/rmd-07-migration.test.ts`：三项入 `RMD_07_RELOCATED` 三元组（长度 47 / 9），两处注释
  与用例标题同步。
- `scripts/__tests__/rmd-06-migration.test.ts`：`control.ts` 三元组第三项改指
  `packages/agent-runtime/src/routes/web/control.ts`，头注释改写为「1.2 暂落宿主、1.5c 改判回本包」的完整
  依据（该断言要求第三项存在，不改会直接失败）。
- `scripts/root-source-owner-rules.ts`：`src/routes/web/control.ts` 规则由 `platform-identity` 改为
  `agent-runtime` + `packages/agent-runtime`，并把 `TARGET_PREFIX_OVERRIDES` 里的 control 条目删除（默认
  推导出的目标正是新落点）；两次改判的依据合并写在该规则上方。
- `docs/arch/root-source-owner-inventory.md`：按规则重新生成，实测**仅这一行**变化
  （`diff` 只有第 81 行）；`check:root-owner-inventory` 报 `files=0 unowned=0 ambiguous=0`。
- `packages/agent-runtime/src/__tests__/registry-environment-isolation-coverage.test.ts`：`normalizePayload`
  用例的去向说明由「迁到宿主测试」改为「1.4 W2 迁宿主、1.5c 随被测函数回本包」（断言集合不变）。
- `scripts/architecture/exceptions.json`：`apps-boundary` 的 `@fenix/agent-runtime → @fenix/server-app` 条目据实
  重测改写——非测试侧 **5 处 / 5 文件**（全部 `@server/db/schema`；`@server/config` 的 1 处随 `a084454c6` 消失，
  removeWhen 的第②条路径因此不再存在），测试侧 **15 处 / 15 文件**（`module-stubs` 13、`@server/db/schema` 1、
  `@server/plugins/error-handler` 1）。本次净增的 1 处即本片新增的 `web-control-routes.test.ts`。

**七、【记录，不在本任务实现】发现的过时引用**

- `FUNCTIONAL_MODULE_INVENTORY.md:40` 仍把 `apps/server/src/routes/web/control.ts` 列为「Agent 会话控制与权限交互」
  的实现文件，并把目标包写成「`agent-session-control`（可并入 `agent-runtime`）」——路径已失效，且本片正是按
  「并入 agent-runtime」落地的。该文件属 1.5g 台账改写范围，此处只登记。
- `review/task-1.4-agent-runtime.md` 遗留表里「`plugins/auth.ts` / `routes/web/control.ts` / `services/resource-module-ports.ts`
  仍从 `./server/environment` 取环境」中的 control 一项已随本片不再成立（该表列的是宿主取用面，本轮后只剩两处）。

**验证证据**：`precheck` 全绿 `All passed (99167ms)`——server-and-script-tests 835 pass / package-tests 7259 pass
（2 skip）/ web-app-tests 946 pass / 0 fail；`architecture`、`dependency-boundaries`、`module-registry`、三项
`tsc`、`lint`、`format`、`import-sort` 均通过。定向运行 `web-control-routes` + `transport-normalize` +
`registry-environment-isolation-coverage` + `rmd-06-migration` + `rmd-07-migration` + `workflow-source-migration`
共 73 pass / 0 fail。

### 1.5c-3a 控制台实例路由迁入 agent-runtime（2026-09-21）

§四 分片表的「environments + instances」一组按可审核粒度拆成两片，本片只做 instances。

**一、迁出与落点**

| 改动 | 文件 |
| --- | --- |
| 新建路由工厂 `createWebInstancesRoutes(deps)` | `apps/server/src/routes/web/instances.ts` → `packages/agent-runtime/src/routes/web/instances.ts` |
| 其两个用例随迁（认证改用包内守卫替身） | `apps/server/src/__tests__/{web-instance-runtime-actions,instances-delete-idempotent}.test.ts` → `packages/agent-runtime/src/__tests__/` |
| `@fenix/agent-runtime/server` 增加出口 | `packages/agent-runtime/src/server.ts` |
| 宿主改为工厂注入（`webInstances` 由 default import 改常量） | `apps/server/src/routes/web/index.ts` |

**二、【需审核】取数裁定：本路由经运行 port，`control.ts` 直引实现，判据是「能力是否在 port 上」**

本片与 1.5c-2 的 `control.ts` 取了**不同**的取数方式，需要一个可复述的判据，否则两者的差异日后会被当成
不一致而「统一」掉：

- **在运行 port 上的能力 → 经 `getBoundAgentRuntime()`**（本片）。实例的生命周期动作
  （`stopInstanceRuntime` / `restartInstanceRuntime` / `deleteInstance` / `createInstance` /
  `ensureInstance` / `getRuntimeSnapshot` / `getOwnedInstance` / `getOwnedEnvironment`）都声明在
  `AgentRuntimePort` 上，而 port 是宿主编排层与用例的**唯一替换点**（`stubAgentRuntimePort`）。直引包内
  模块函数等于给同一批能力开第二个替换点——正是 1.4 W3b 收敛掉的形态（此前用例靠 monkey-patch 包内单例）。
- **不在 port 上的实现 → 直引**（`control.ts`）。它用的是会话总线、`agentInstanceService` 的仓储读与
  `services/session`，这些不属 port 的能力面（总线另经 `session-event-bus-port` 由宿主注入），直引不会
  产生第二个替换点。

**「包内路由取绑定入口 = 自引用本包入口」的顾虑不成立**：`createAgentRuntime()` 内部持有的都是本包模块级
单例（`agentInstanceService`、`globalInstanceRegistry`、relay 连接表），多次构造不产生第二套运行状态
（`runtime.ts` 的注释与 `createAgentRuntimeModule()` 的幂等语义即为此设计）。因此包内路由经绑定入口取用
不会分裂状态机、注册表或 lease 状态——用户红线「实例起来之后怎么管不动」在本片成立：**本片没有触碰任何
状态机、幂等、lease、限流、disconnect fencing 或 dispose 逻辑**，只改路由的落点与守卫注入方式。

**三、测试随迁**

两个用例都直接 `handle(Request)`（不经宿主挂载），因此只需替换认证来源：宿主 `@server/plugins/auth` 的
`setTestAuth` 换成包内 `./guard-stubs`，形状由 `{ user, authContext: { role, … } }` 收窄为
`{ organizationId, userId }`（包内替身只维护路由真正消费的两个标识，见 `guard-stubs.ts` 的说明）。
`stubAgentRuntimePort` / `stubCoreBootstrap` / `setOrchestrationInstanceDeps` 等注入方式一概不变。

一处需要记录的事实：`instances-delete-idempotent.test.ts` 的用例标题与注释仍在描述「已停止 → 200 幂等」
的**旧契约**，而断言实际锁定的是 **404**（现代码先做归属校验，环境查不到即 404）。这是本片之前就存在的
描述与断言不一致，属该用例自身的历史（AE-P2.1 之后的契约演进），本片只迁不动：既不改断言也不改标题，
登记为待复核项。

**四、台账同步**

- `scripts/__tests__/rmd-07-migration.test.ts`：两项入 `RMD_07_RELOCATED`（长度 47 → 45、9 → 11），两处
  注释块补记理由（其中说明 `instances-delete-idempotent.test.ts` 不在本表内、随本片一并迁入）。
- `scripts/root-source-owner-rules.ts`：删除 `RETAINED_HOST_TEST_RATIONALES` 里的
  `src/__tests__/web-instance-runtime-actions.test.ts` 条目——该测试已不在宿主，保留理由不再成立（1.4 W2b
  先例：迁出文件不补规则表条目，只清理 rationale）。`src/routes/web/instances.ts` 无专门规则（落在
  `src/routes/web/` 通配下），按同一先例不动。

**五、【记录，不在本任务实现】** `instances-delete-idempotent.test.ts` 的标题/注释与断言不一致（见三）。

**验证证据**：`precheck` 全绿 `All passed (100745ms)`——server-and-script-tests 828 pass（较上片少 7 例，
即本片迁出的 2 + 5）、package-tests 7266 pass（+7）/ web-app-tests 946 pass / 0 fail；`architecture`、
`dependency-boundaries`、`module-registry`、三项 `tsc`、`lint`、`format`、`import-sort` 均通过。定向运行
迁入的两个用例 + `rmd-07-migration` 共 9 pass / 0 fail；`check:root-owner-inventory` 报
`files=0 unowned=0 ambiguous=0`。
