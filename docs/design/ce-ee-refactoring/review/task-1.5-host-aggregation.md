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

### 1.5c-3b 控制台环境路由迁入 agent-runtime（2026-09-21）

**一、迁出与落点**

| 改动 | 文件 |
| --- | --- |
| 新建路由工厂 `createWebEnvironmentsRoutes(deps)`，同时删掉末尾的 `export default createEnvironmentRoutes()` | `apps/server/src/routes/web/environments.ts` → `packages/agent-runtime/src/routes/web/environments.ts` |
| 其用例随迁（30 例，认证改用包内守卫替身） | `apps/server/src/__tests__/round44-environments-routes.test.ts` → `packages/agent-runtime/src/__tests__/` |
| `@fenix/agent-runtime/server` 增加出口 | `packages/agent-runtime/src/server.ts` |
| 宿主改为工厂注入 | `apps/server/src/routes/web/index.ts` |

default 自执行导出被删除的理由：宿主是唯一的挂载方，`export default createEnvironmentRoutes()` 会让**任何**
导入方都构造一份路由实例（含测试的 `mock.module` 转发表），与「工厂 + 宿主注入守卫」的形态冲突。

取数方式与 1.5c-3a 的 instances 一致（经 `getBoundAgentRuntime()`，判据见 1.5c-3a 的 §二）——环境能力同样
声明在 `AgentRuntimePort` 上。本片同样**没有触碰**任何状态机、幂等、lease、限流、disconnect fencing 或
dispose 逻辑。

**二、测试随迁时的两处口径调整**

1. **认证改经包内守卫替身**：`@server/plugins/auth` 的 `setTestAuth` 换成 `./guard-stubs`，形状由
   `{ user, authContext: { role, … } }` 收窄为 `{ organizationId, userId }`。30 个用例全部通过，未改任何断言。
2. **`setTestOrgContext` 与 `stubAuthApi` 一并消失**：前者是宿主 `services/org-context.ts` 的测试 seam
   （让 `loadOrgContext` 跳过 DB 查询），后者替换宿主 auth 插件的凭据解析。两者服务于**宿主装配路径**，
   而包内守卫替身直接提供 `authContext` 并自行判定未认证，因此迁入后不再需要——「未认证返回 401」这条
   用例只保留 `resetTestAuth()`。这不是能力丢失：组织解析与凭据解析都属宿主守卫的职责，其验收范围在宿主
   装配用例（`guard-stubs.ts` 的注释已写明包内替身刻意不复刻这些规则）。

**三、台账同步**

- `scripts/__tests__/rmd-07-migration.test.ts`：`src/routes/web/environments.ts` 移入 `RMD_07_RELOCATED`
  （长度 45 → 44、11 → 12），两处注释块补记（含说明 `round44-environments-routes.test.ts` 不在本表内）。
- `scripts/architecture/exceptions.json`：`apps-boundary` 的 `agent-runtime → server-app` 条目再次据实重测——
  测试侧由 15 处 / 15 文件升为 **17 处 / 17 文件**（`module-stubs` 13 → 15），新增的两处即本片与上一片迁入的
  `round44-environments-routes.test.ts` 与 `instances-delete-idempotent.test.ts`；非测试侧不变（5 处
  `@server/db/schema`）。三处新增都属「宿主测试基建的既有耦合」这一已登记形态，不是包对宿主生产实现的依赖。
- `scripts/root-source-owner-rules.ts` **无需改动**：该文件里 `src/__tests__/round44-environments-routes` 的
  规则本就登记为 `agent-runtime`（`scripts/__tests__/root-source-owner-inventory.test.ts:176` 也如此断言），
  本片的落点与台账原本的预期一致；`src/routes/web/environments.ts` 无专门规则（落在 `src/routes/web/` 通配下），
  按 1.4 W2b 先例不补条目。

**验证证据**：`precheck` 全绿 `All passed (100591ms)`——server-and-script-tests 798 pass（较上片少 30 例，
即本片迁出的 30）、package-tests 7296 pass（+30）/ web-app-tests 946 pass / 0 fail；`architecture`、
`dependency-boundaries`、`module-registry`、三项 `tsc`、`lint`、`format`、`import-sort` 均通过。定向运行
迁入的 30 例 + `rmd-07-migration` + `root-source-owner-inventory` 共 55 pass / 0 fail。

### 1.5c-4 Peri 任务详情路由与协议契约归位 model-management（2026-09-21）

**一、迁出与落点**

| 改动 | 文件 |
| --- | --- |
| 新建路由工厂 `createWebPeriTaskDetailsRoutes(deps)` | `apps/server/src/routes/web/peri-task-details.ts` → `packages/resources/model-management/src/server/routes/web/peri-task-details.ts` |
| 删除宿主协议副本（与包内副本字节相同） | `apps/server/src/schemas/peri-task-details.ts`（owner 落点 `packages/resources/model-management/src/server/schemas/peri-task-details.ts`，1.3 已存在） |
| 包入口增加路由出口与两项依赖类型 | `packages/resources/model-management/src/server.ts`、`.../src/server/routes/dependencies.ts` |
| 宿主注入端口 | `apps/server/src/services/resource-module-ports.ts` |
| 宿主改为工厂注入、删除本地副本导入 | `apps/server/src/routes/web/index.ts` |

**二、【需审核】环境归属校验改由宿主注入**

判据：§2.3 依赖矩阵里 `packages/resources/<resource>` 的可依赖面是 `platform-sdk` + 本资源基础依赖 +
**其他资源包**根入口公开的 service/DTO；`agent-runtime` 既不是 `platform-sdk` 也不是资源包，且与资源包
同层，矩阵未登记 `model-management → agent-runtime` 方向。因此不让 model-management 反向依赖该包，改为
宿主注入，落点是既有的 `resource-module-ports.ts`——该文件头注释的第一类能力「跨包的窄查询」正是
「Environment 的 owner 在 agent-runtime」这一情形，`environmentLookup` 是先例。

注入形状按消费侧语义声明（`EnvironmentOwnershipCheck`：校验通过即返回，不存在 / 跨组织 / 跨用户都抛错；
返回值本包不消费），**不引用** `@fenix/agent-runtime` 的类型，因此不产生资源包对该包的编译期依赖。

宿主实现走 `getBoundAgentRuntime().getOwnedEnvironment(...)` 而不是直读 `environmentRepo`：归属判据只在
运行 port 的实现里，仓储不做这件事；取用写在调用期而不是模块加载期，宿主测试的 port 替身
（`stubAgentRuntimePort`）才能在用例内生效。这与 1.5c-2 / 3a / 3b 的「能力在 `AgentRuntimePort` 上就经
port 取」是同一判据，区别只在注入方向：那三片的消费方在 agent-runtime 包内，本片的消费方在资源包。

**三、协议契约的第二份定义被清除**

宿主 `apps/server/src/schemas/peri-task-details.ts` 与包内副本除文件头注释外**字节相同**（`diff` 仅报
12 行新增注释）：1.3 已把 owner 判给 model-management 并把 schema 落进包内，但宿主副本未随之删除，宿主路由
也一直从 `../../schemas/peri-task-details` 取本地副本，而不是像包入口注释声称的「经本入口取 schema」。本片
按「删除优于兼容」删除宿主副本，宿主不再持有第二份协议定义，包内 `src/server.ts` 的过时注释同步改写。

**四、只搬迁**

路由路径、`sessionAuth: true` 宏、`detail` 元数据、响应 schema 与「以 404 隐藏归属差异」的语义逐字保留；
`biome-ignore` 的理由注释一并保留（Elysia 在 response schema + error 分支组合下的类型推断问题仍在）。
`docManager` 仍由包内直引（`@fenix/chat-channel/server` 是本包已声明依赖，矩阵允许资源包依赖独立 SDK 包），
投影存储仍是模块级构造一次。未触碰任何生命周期、幂等或并发逻辑。

**五、台账同步**

- `scripts/__tests__/rmd-07-migration.test.ts`：两项移入 `RMD_07_RELOCATED`（MOVES 44 → 42、
  RELOCATED 12 → 14），两处注释块补记。
- `scripts/root-source-owner-rules.ts` **无需改动**：两条路径都无专门规则（分别落在 `src/routes/web/` 与
  `src/schemas/` 通配下），按 1.4 W2b 先例「迁出文件不补规则表条目」不动。
- `scripts/architecture/exceptions.json` **无需改动**：本片删除的是宿主文件、新增的是宿主侧同一处注入，
  没有产生新的包 → 宿主 `@server/*` 依赖，apps-boundary 计数不变。
- `src/__tests__/peri-task-detail-service.test.ts` **仍留在宿主**（`RETAINED_HOST_TEST_RATIONALES` 的
  「跨服务投影装配」）：它直接调用包内的 `getPeriTaskDetail` 并自建 store 替身，不经过本片迁走的路由，
  保留理由仍成立。

**六、【记录，不在本任务实现】**

包内 `src/server/schemas/peri-task-details.ts` 的文件头记录了归属偏差：1.3 review 的归属裁定把 peri-task
一族划给 `task` 包，但本包 manifest 的 `dependsOn` 已冻结为 `["agent-config"]`，改引会让依赖声明不完整，
故当时维持在 model-management。本片是搬迁，不改变该判断，纠正留给后续波次连同 manifest 一起改。

**验证证据**：`precheck` 全绿 `All passed (99785ms)`——server-and-script-tests 798 pass / package-tests
7296 pass / web-app-tests 946 pass / 0 fail；`architecture`、`dependency-boundaries`、`module-registry`、
三项 `tsc`、`lint`、`format`、`import-sort` 均通过。定向运行 `rmd-07-migration` +
`root-source-owner-inventory` 25 pass / 0 fail、model-management 包 226 pass / 0 fail、保留宿主用例
`peri-task-detail-service.test.ts` 6 pass / 0 fail；`check:root-owner-inventory` 报
`files=0 unowned=0 ambiguous=0`。本片无测试随迁，故 server 侧用例数与上片持平。

### 1.5c-5 Meta Agent 路由归位 agent-config（2026-09-21）

**一、迁出与落点**

| 改动 | 文件 |
| --- | --- |
| 新建路由工厂 `createWebMetaAgentRoutes(deps)` | `apps/server/src/routes/web/meta-agent.ts` → `packages/resources/agent-config/src/server/routes/web/meta-agent.ts` |
| 包入口增加路由出口与依赖类型 | `packages/resources/agent-config/src/server.ts`、`.../src/server/routes/dependencies.ts` |
| 宿主改为工厂注入 | `apps/server/src/routes/web/index.ts` |

**二、`rotateCallerApiKey` 仍由宿主注入，类型改为必填**

`ensureMetaEnvironment` 的编排与 `EnsureMetaAgentResponseSchema` 本就在 agent-config，宿主那份只是协议接入
壳，唯一宿主侧实现是 identity 的 `rotateCallerApiKey`——资源包不得依赖 `@fenix/identity`（§2.3），且「同名
key 只保留一把」的编排只应在身份侧实现一处（理由已写在 `services/meta-agent` 的 `RotateCallerApiKey` 注释）。
本片只把宿主文件里那句 `const metaAgentDeps = { rotateCallerApiKey }` 换成工厂依赖字段。

新增依赖类型 `WebMetaAgentRouteDependencies` 把该字段声明为**必填**（服务侧的 `MetaAgentDependencies` 是可选，
因为服务还要支持测试直接调用）：宿主是唯一装配方且一直提供，必填能让缺注入在装配期暴露，而不是等 meta
environment 拉起时以 500 的形式暴露。

**三、只搬迁**

路由路径、`sessionAuth: true` 宏、401 / 500 两条错误分支的形状与文案、`detail` 元数据、日志模块名
（`createLogger("meta-agent")`）与 `biome-ignore` 的理由注释逐字保留。未触碰 `ensureMetaEnvironment` 的
任何编排逻辑（meta environment 的 `(organizationId, userId, name)` 三元组隔离、apiKey 进程内缓存、
实例 spawn/复用判定均未改动）。

**四、台账同步**

- `scripts/__tests__/rmd-07-migration.test.ts`：本项移入 `RMD_07_RELOCATED`（MOVES 42 → 41、
  RELOCATED 14 → 15），两处注释块补记。
- `scripts/root-source-owner-rules.ts` **无需改动**：`src/routes/web/meta-agent.ts` 无专门规则（落在
  `src/routes/web/` 通配下），按 1.4 W2b 先例不补条目；该文件里已有的 `src/services/meta-agent.ts`、
  `src/schemas/meta-agent.schema.ts`、`web/src/api/meta-agent.ts` 三条 RMD-04 规则指向的是另外三件，
  不受本片影响。
- `scripts/architecture/exceptions.json` **无需改动**：本片没有产生新的包 → 宿主 `@server/*` 依赖，宿主侧
  删除的是路由壳、新增的是同一处注入。
- 无测试随迁：`apps/server/src/__tests__/` 下从来没有 meta-agent 用例，包内 `__tests__/meta-agent.test.ts`
  覆盖的是服务编排，本片不改动其被测对象。

**五、非确定性失败的记录**

本片第一次 `precheck` 报 1 fail：`round37-service-boundaries.test.ts` 的
「Sandbox sandbox-boundary-03 首次等待失败后重启资源并补偿为可连接状态」。证据与判定：①该用例以
`runtimeConnectTimeoutMs: 1`（1 毫秒）驱动等待循环，属时间敏感用例；②单独运行该文件 130 pass / 0 fail；
③该文件的导入图只有 agent-runtime / platform-sdk / resource-machine / resource-sandbox，与本片改动
零交集；④复跑 `precheck` 全绿。故判定为既有的非确定性失败，非本片引入，未做任何改动。

**验证证据**：`precheck` 全绿 `All passed (99811ms)`——server-and-script-tests 798 pass / package-tests
7296 pass / web-app-tests 946 pass / 0 fail；`architecture`、`dependency-boundaries`、`module-registry`、
三项 `tsc`、`lint`、`format`、`import-sort` 均通过。定向运行 `rmd-07-migration` +
`root-source-owner-inventory` + 包内 `meta-agent.test.ts` 共 29 pass / 0 fail。

### 1.5c-6 用户偏好读写随 `user_config` 表归位 identity（2026-09-21）

**一、迁出与落点**

| 改动 | 文件 |
| --- | --- |
| `getUserConfig` / `setUserConfig` 迁入 identity 的仓储层，DB 句柄改 `getIdentityDatabase()` | `apps/server/src/services/config/user-config.ts` → `packages/platform/identity/src/repositories/user-config.ts` |
| 包入口增加出口（值 + 两个类型） | `packages/platform/identity/src/server.ts` |
| 宿主适配端口改从 identity 取用 | `apps/server/src/services/resource-module-ports.ts` |
| 宿主 config barrel 去掉两条转发 | `apps/server/src/services/config/index.ts` |
| 宿主 schema 的 `userConfig` 转出与顶部注释据实修正 | `apps/server/src/db/schema.ts` |

归属判据：`user_config` 的真相来源本就是 `packages/platform/identity/db/schema.ts`（CLAUDE.md「数据库与迁移」），
读写却留在宿主，属「表与它的读写分处两层」。落到 `repositories/` 而不是 `services/`：它只做单表读取与 upsert，
不含业务规则，与 identity 既有的 `repositories/{user,organization}.ts` 同层同类。

**二、【需审核】取数方向与类型口径**

- **宿主是唯一消费者**：identity 属 `platform-impl`，按 §2.3 任何资源模块与 Agent Runtime 都不得导入其入口
  （该约束已写在其 `server.ts` 头部），宿主 `apps/server` 是合法消费者——与既有的 `createWebApiKeysRoutes`、
  `rotateCallerApiKey` 同口径。资源包侧仍只经宿主的注入端口（`userAgentPreferences` /
  `userModelPreferences`）取数，未新增任何包 → identity 的编译期依赖。
- **`permission` 在 identity 侧声明为 `unknown`**：持久层只做 jsonb 透传，不做结构校验。宿主适配端口原先的
  `patch.permission as PermissionConfig | null | undefined` 收窄随之删除（两侧形状一致），宿主权限栈的模型
  不再被拖进身份包的编译面。

**三、测试 seam 的改指向（行为等价，用例与替身写法不变）**

`setup-mocks.ts` 原先把 `getUserConfig` / `setUserConfig` 挂在 `@server/services/config` barrel 的替身上；本片把
这两个键改按 identity 仓储模块登记（`mock.module(".../identity/src/repositories/user-config", …)`），与既有的
`.../identity/src/services/system-api`、`.../identity/src/db` 是同一做法——`mock.module` 按解析后的模块路径生效，
包入口的 re-export 会取到替身。替身注册表仍是同一个 `config-pg-stub`，因此所有用例侧的
`stubConfigPg({ getUserConfig, setUserConfig })` 与断言一行未改。

**替身确实生效的证据**：`config-integration.test.ts` 的「models 路由可达」断言 `success: true`，而该路由会经
端口读偏好；若替身未生效，真实实现会在用例的 DB 替身上调用 `.where(...).limit(1)`（`stubDb` 只声明到 `where`）
抛错 → 500，该断言必然失败。这条用例本片通过。

**四、两处过时引用一并清掉**

- 宿主 `db/schema.ts` 的 `userConfig` 转出：迁出后宿主对该表零引用（`grep` 只剩转出行本身），删除转出与
  注释里「宿主内的身份读取（如 `services/config/user-config.ts` 读 `user_config`）」一句。迁移链不受影响：
  `drizzle.config.ts` 直接声明 `packages/platform/identity/db/schema.ts`。
- 两个资源包端口注释里指向已不存在文件的路径（`user-config.ts` 用 `!== undefined` 判定）改为指向新落点。

**五、【记录，不在本任务实现】`services/config/index.ts` 的去留**

该 barrel 现在只剩 `upsertSystemMcpServer`（其对应的 Hindsight MCP 路径全仓未接线，1.5a 记录已登记，处置留给
1.5c 收尾）与类型转发，宿主内已零导入方。本片不删它：删除需要与 `mcp-system-server.ts` 的去留（写进 memory 包
还是删除）一起决定，属独立裁定，另片处理。

**六、台账同步**

- `scripts/__tests__/rmd-07-migration.test.ts`：本项移入 `RMD_07_RELOCATED`（MOVES 41 → 40、
  RELOCATED 15 → 16），两处注释块补记。
- `scripts/root-source-owner-rules.ts` 与 `scripts/architecture/exceptions.json` 均**无需改动**：
  `src/services/config/user-config.ts` 无专门规则（落在 `src/services/config/` 一类通配下，按 1.4 W2b 先例
  不补条目），本片也未产生新的包 → 宿主依赖。

**验证证据**：`precheck` 全绿 `All passed (101686ms)`——server-and-script-tests 798 pass / package-tests
7296 pass / web-app-tests 946 pass / 0 fail；`architecture`、`dependency-boundaries`、`module-registry`、
三项 `tsc`、`lint`、`format`、`import-sort` 均通过。定向运行 `rmd-07-migration` +
`config-integration` 17 pass / 0 fail（后者是偏好端口端到端用例，见三）。

### 1.5c-7 `services/core-bootstrap.ts` 按 §3.4 拆分（2026-09-21）

计划原文（§四 1.5c 行）：「`services/core-bootstrap.ts` 按 3.4 拆分（`ensureMachineExists` → machine，
实例注册表 → agent-runtime）」。

**一、迁出与落点**

| 改动 | 文件 |
| --- | --- |
| 兜底机器记录的补齐迁入 machine 包，改 `ensureDefaultMachine({ machineId, agentName })`（幂等，返回是否新建） | 宿主 `ensureMachineExists` → `packages/resources/machine/src/server/services/registry.ts` |
| 宿主启动改为调用包导出，部署值仍由宿主提供 | `apps/server/src/services/core-bootstrap.ts` |
| 实例登记表收敛（删 core 实例 + 配对注销登记表 + 编排域活跃表）迁入 agent-runtime | 新增 `packages/agent-runtime/src/services/machine-instance-cleanup.ts`（`convergeMachineInstances`） |
| 端口面：两个旧方法合并为一个 | `packages/agent-runtime/src/runtime.ts`（`AgentRuntimePort`） |
| 宿主三个使用点（重连分支、断连、沙盒释放）改调单一入口 | `apps/server/src/services/core-bootstrap.ts` |

**二、【需审核】「实例注册表 → agent-runtime」的落法**

宿主 `core-bootstrap` 原有两段与实例登记表有关的代码：①循环 `runtime.listInstances()` 删该 machine 的
core 实例、逐个 `unregisterInstance`；②调用编排域收敛 `cleanupInstancesForMachine`。候选取法有三：

1. **把整个收敛编排搬到 agent-runtime 的断连/重连调用点**（宿主只留节点与 transport）。否决：沙盒释放
   （`Sandbox → Machine.releaseMachineRuntime → MachineHostPort.unregisterCoreRuntimeNode`）不经 ACP
   handler，宿主绑定必须继续承载这段清理，否则沙盒销毁会永久占用并发额度（现有注释 E-P0.1 正是为此）。
   两处各写一份收敛代码则违背单一 owner。
2. **宿主直接 import agent-runtime 的收敛函数**。否决：1.4 已把这两次调用从包内直连改为经 port
   （`unregisterInstance` 即当时新增），回退等于撤销已交付裁定。
3. **收敛成一个 port 方法，实现在包内**（本片采用）。宿主持有 core 单例、只决定「何时收敛」，三条路径
   （重连 / 断连 / 沙盒释放）都走同一入口；「删 core 实例」与「注销登记表」在实现里不可分——
   调用方拿不到中间态，也就没机会漏配对。

**三、端口面收缩（管理面 41 → 40 方法）**

- `cleanupInstancesForMachine(machineId): number` 与 `unregisterInstance(instanceUid): void` 合并为
  `cleanupMachineInstances(machineId): number`（返回从 core 删掉的实例数；旧方法的返回值只有编排域计数，
  唯一消费者是宿主的日志，见下）。**这是有意的契约面收缩**：两个方法的唯一消费者都是宿主的同两处循环，
  合并后旧方法零消费方，按「删除优于兼容」不留零消费者的 port 成员。
- `unregisterInstance` 的文档契约（「宿主把实例从 Core runtime 删除时必须配对调用」）由新方法内部保证，
  不再是调用方的义务。
- 1.4 评审 §（`packages/agent-runtime/src/runtime.ts` 一行）记的「新增 `unregisterInstance`」属历史记录，
  不追改；本条即其被取代的落点。

**四、行为等价声明**

- **顺序不变**：重连分支仍是「`updateNodeStatus(online)` → 删实例 → 编排域收敛」；断连仍是
  「节点置 offline → 删实例 → 编排域收敛」；沙盒释放仍走 `unregisterRemoteNode`。
- **编排域收敛仍无条件调用**（core 侧无实例时也调用），与迁出前的两处一致。
- **日志文本变化**：原先两条按上下文区分的行（`[core-bootstrap] Deleted instance X on reconnected/
  disconnected machine Y`）改为一条 `[machine-instance-cleanup] Deleted instance X on machine Y`——包内
  不知道调用上下文；无任何用例断言这些日志（`grep` 确认仅存在于被删代码内）。兜底机器记录的日志同理
  改为 `[registry] Auto-created default machine …`。
- **宿主端行为面不变**：`registerRemoteNode` / `unregisterRemoteNode` / `initCoreRuntime` 的签名、调用点
  （`main.ts`、`acp-ws-handler`、`MachineHostPort` 绑定）与装配顺序一行未动。

**五、测试与 seam**

- 新增 `packages/agent-runtime/src/__tests__/machine-instance-cleanup.test.ts`（3 例）：只删目标机器的实例、
  配对注销登记表条目、其它机器不受影响；core 实例为空时仍收敛编排域（沙盒释放路径的关键语义）；
  幂等重入。core 单例经宿主 preload 的 `stubCoreBootstrap` 注入假 facade，与包内既有接缝一致。
- `packages/resources/machine/src/__tests__/round39-registry-service.test.ts` 增 2 例：缺失时补建系统记录
  （`organizationId` / `userId` 为 null、`status=pending`）、已存在时不写（幂等，不覆盖注册信息）。
- 宿主用例零改动：`@server/services/core-bootstrap` 在 preload 里是整模块替身（`stubCoreBootstrap`），
  其函数体不执行，故两处循环的搬走对宿主测试进程不可见；`machine-cleanup-node-dispatch.test.ts` 等
  替身 `unregisterRemoteNode` 的用例同样不受影响。

**六、台账同步**

- `scripts/root-source-owner-rules.ts`、`scripts/architecture/exceptions.json`、`rmd-07-migration.test.ts`
  均无需改动：`core-bootstrap.ts` 仍留在宿主目标路径（`RMD_07_MOVES` 条目不变），本片未新增包 → 宿主依赖，
  也未增删文件清单。
- `packages/agent-runtime/src/__tests__/runtime-port.test.ts` 的清单同步（管理面 41 → 40、两条换一条）——
  该用例的设计意图就是让 port 面的每次增删都必须显式落到测试上。
- `FUNCTIONAL_MODULE_INVENTORY.md` 两行（「应用启动、模块装配与内置资源」「插件注册表与 Core Runtime」）
  仍指向宿主 `core-bootstrap.ts` 且语义成立（Core 单例、节点与 transport 缓存都留在宿主），本片不改。
- 注释同步：`orchestration-machine-cleanup.ts` 的「背景/调用方」两段、`remote-file-service.ts` 提到
  「兜底机器由 core-bootstrap 自动创建」的一句，均改指新落点。

**验证证据**：`precheck` 全绿 `All passed (97408ms)`——server-and-script-tests 798 pass / package-tests
7301 pass（较 1.5c-6 的 7296 增 5，即本片新增的 3 + 2 例）/ 2 skip / web-app-tests 946 pass / 0 fail；
`architecture`、`dependency-boundaries`（2383 modules，0 条新增违规）、`module-registry`、三项 `tsc`、
`lint`、`format`、`import-sort` 均通过。定向运行 `machine-instance-cleanup`（3 pass）、`runtime-port`、
`orchestration-machine-cleanup`、`machine-cleanup-node-dispatch`、`round39-registry-service` 共 47 pass / 0 fail。

### 1.5c-8 `services/config/*` 与 `config-utils.ts` 信封函数删除（2026-09-21）

1.5a 计划行原文：「`services/config/index.ts`、`services/config-utils.ts` 的信封函数（`resolveApiKey`
保留）、`services/config/mcp-system-server.ts`（零消费方薄包装）」，判据「删除后 `precheck` 全绿；每项删除
均有『零生产消费方』证据」。1.5a 交付记录把后两项留到本片（见 §七 1.5a「本轮未动」），本片收口。

**一、删除清单与零消费方证据**

| 项 | 「零生产消费方」证据 | 现 owner / 取代者 |
| --- | --- | --- |
| `services/config/mcp-system-server.ts`（23 行） | 唯一消费者是同批删除的 `services/config/index.ts`；它服务的端口 `RegisterSystemMcpServer` 从未被注入——`ensureHindsightMcpServer` 在 `apps/**` 命中 0 处生产调用，包内只有 `src/server/services/hindsight.ts` 的定义与 7 条用例 | 接线时在装配点委托一次 `getMcpServerModule().service.upsertSystemServer`（原包装体就是这一行） |
| `services/config/index.ts`（3 行 barrel） | 三条导出全零导入方：`upsertSystemMcpServer`（同上）、`AuthContext` 类型（宿主全部 `AuthContext` 消费方都直接取自 `plugins/auth`，如 `sync-builtin.ts` / `org-context.ts`）、`PermissionAction` / `PermissionConfig`（宿主无消费方）。唯一提到该路径的代码是 `setup-mocks.ts` 的 `mock.module("@server/services/config")`，而仓内没有任何用例需要它提供的键 | `services/config/types.ts` 保留（`env.ts` 的 `ENGINE_TYPES` 取自它，`rmd-07` 条目不变） |
| `config-utils.ts` 的 8 个信封/工具函数（`configSuccess` / `configError` / `configNotFound` / `configValidationError` / `isValidResourceName` / `toKeyHint` / `safeJsonStringify` / `safeJsonParse`） | 生产消费方只有 `resolveApiKey`（`services/resource-module-ports.ts:27` 的 `resolveSecretReference`）一个；其余 8 个只被 `round16` / `round22` 两条宿主用例引用 | 包内自持：`@fenix/model-management` 的 `src/server/config-envelope.ts`（`configSuccess` / `configError` / `toKeyHint`，其 `toKeyHint` 改为传入 resolver）、`@fenix/agent-config` 的 `isValidAgentName`（与 `isValidResourceName` 逐字符等价，agent-config README 早已登记「删除时须同批改这两条用例」）；`safeJson*` 的唯一消费方是已迁出的旧 `/web/config/*` 路由，迁出后无取代者 |

**二、`upsertSystemMcpServer` 两候选的取舍（1.5a 留给本片的判断）**

- **候选「迁入 memory 包」不成立**：memory 包的 `fenix.module.ts` 把 `dependsOn` 冻结为 `[]`
  （`assertDependsOnDeclared` 要求每条都在 `package.json` 有 workspace 依赖），而写入实现属
  `@fenix/resource-mcp`——跨包依赖过不去，这正是当初引入 `RegisterSystemMcpServer` 参数注入的原因
  （`hindsight.ts` 头注释）。把宿主这份适配器搬进 memory 包只会复现同一个依赖问题。
- **采用删除**：整条 Hindsight 登记路径未接线（`ensureHindsightMcpServer` 生产零调用；`main.ts:227` 只把
  `HINDSIGHT_MCP_URL` 传进模块配置，没有消费者），宿主这 6 行是死适配器。删除不改变 memory README 第 10 条
  遗留的 (a) 接线 / (b) 删除 裁定——那条裁定针对**包内**登记实现与 7 条用例，本片未动它们；本片只是把「接线」
  的成本降到装配点一次委托，已在该条尾部补记。

**三、测试处置**

- `round16`（−11 例）/ `round22`（−28 例）中被删函数的部分同步删除，保留 `resolveApiKey`（宿主仍要注入它）
  与两文件其它主题；两文件头部注释改写，说明「输入边界」现在只剩密钥解引用与系统提示词拼装，以及被删部分的
  行为由哪里覆盖。
- **为什么不把断言改指包内实现**：包内 `toKeyHint` 多一个 resolver 形参、`configSuccess` / `configError` 的
  消费方是包内路由工厂，签名与调用面都与宿主版不同，且包内已有自己的用例
  （`round-config-providers-routes.test.ts` 经 provider 视图覆盖 keyHint 与信封形状）。宿主侧再抄一份断言
  等于给包内实现加第二套测试入口，与「同一能力只有一个 owner」相悖。

**四、台账同步**

- `scripts/__tests__/rmd-07-migration.test.ts`：`RMD_07_MOVES` 移出 `services/config/index.ts` 一项，
  长度 40 → 39，并在 MOVES 注释块末尾补记本批删除理由（含「另两个删除项不在本表内」的说明）。
- `scripts/root-source-owner-rules.ts`：无本批相关条目（`RETAINED_HOST_TEST_RATIONALES` 中 `round16` /
  `round22` 两条仍成立——文件保留、主题未变）；`scripts/architecture/exceptions.json`、`FUNCTIONAL_MODULE_INVENTORY.md`
  对本批无命中。

**五、注释与 README 同步**

- 包内注释三处改为现在时的事实陈述：`memory/.../hindsight.ts` 的端口注释（不再声称宿主已有可原样传入的实现，
  改述为「宿主在接线处委托一次」+ 删除记录）、`mcp/src/__tests__/mcp-source-migration.test.ts` 的
  「不在本清单里」说明、`mcp/src/server/runtime.ts` 的环约束说明（保留约束，补记该文件已删除）。
- README 三份：`memory/README.md` 第 10 条追加 2026-09-21 更新（见上）；`mcp/README.md` 的领域服务条改为
  「宿主在接线处经 `./server/runtime` 调用」；`agent-config/README.md` 把 `isValidResourceName` 从「待宿主
  删除」挪入「已删除」清单。
- **顺带修正一处 1.5c-6 遗留的失真**：`agent-config/README.md` 同一段落的「宿主 `user_config` 的读写」条目仍
  指向 1.5c-6 已删除的 `apps/server/src/services/config/user-config.ts`，随本次同段改写为 identity 的
  `src/repositories/user-config.ts`。同因的 `packages/platform/identity/README.md:45`（消费者路径同样过时）
  不在本片改动面内，留 §1.5g。

**验证证据**：定向运行 `round16` / `round22` / `config-integration` / `rmd-07` 共 47 pass / 0 fail；
`mcp` + `memory` 两包 291 pass / 0 fail。`precheck` 全绿 `All passed (101203ms)`——server-and-script-tests
**759 pass / 0 fail**（较 1.5c-7 的 798 少 39，恰为本片删除的 11 + 28 条断言，无其它用例受影响）；
package-tests 7301 pass / 2 skip / 0 fail（与 1.5c-7 持平）；web-app-tests 946 pass / 0 fail；
`architecture`、`dependency-boundaries`、`module-registry`、三项 `tsc`、`lint`、`format`、`import-sort` 均通过。

### 1.5d platform-sdk 契约扩展（2026-09-21）

分片行原文：「【需审核】platform-sdk 契约扩展：`ModuleFactoryContext.declarations`、
`ModuleManifest.accessControlBindings`、`ModuleContribution.order`、`ServerRouteHost` 与宿主协议 adapter 面；
access-control / mcp / skill / agent-config / model-management 的 `create` 改为接收声明并去掉「已知不足」
注释」，判据「`bootstrap.test.ts` 扩测新契约；`access-control` 与 mcp 的 create 返回真实例而非命名空间」。

**一、§3.2 / §3.3 的落地对照**

| 裁定项 | 落地位置 | 本片状态 |
| --- | --- | --- |
| `ModuleFactoryContext.declarations` | `platform-sdk/src/assembly/module-manifest.ts` 加字段（含「为什么走声明面」注释）；`bootstrap.ts` 的 create 阶段传 `resolved.modules` | 拓扑序的启用 manifest 全集，实例化前即可读 |
| `ModuleManifest.accessControlBindings` | 同文件加可选字段；`access-control` 的工厂 `flatMap` 汇总 | 四个受控资源 manifest 各自声明 `xxxResource.storage` |
| `ModuleContribution.order` | 同文件加可选字段；`bootstrap.ts` 新增 `orderContributions()` 稳定排序 | 默认 0，同值保持「拓扑序 + manifest 内声明序」 |
| `ServerRouteHost` | `platform-sdk/src/server.ts`（7 字段全 `unknown`） | **本片只定义、无消费方**——§3.3 的路由贡献挂载在 1.5e 落地 |
| 三处「已知不足」注释 | access-control / mcp / skill / agent-config / model-management 的 `fenix.module.ts` 与 `src/module.ts` | 删除，改写为现在时的事实陈述（含新的约束说明） |

`create` 改动明细：

- `access-control`：`create: () => import("./src/suite")`（返回包命名空间）→ `createDrizzleAccessControl({ database: getDatabase<AccessControlDatabase>(), bindings: context.declarations.flatMap((m) => m.accessControlBindings ?? []) })`。
  `database` 与 `identity` 不新增注入面（§3.2 第 3 条）：沿用 `@fenix/platform-sdk/server` 的 `getDatabase()`，与 1.4 在 agent-runtime 上的模式一致。
- 四个资源包：`create: () => import("./src/module").then((m) => m.createXxxModule())` → 传入 `context`；包内 `src/module.ts` 删除 `McpModule` 式的「装配结果命名空间」包装接口，改为从 `context.modules` 取 access-control 端口、从 `@fenix/platform-sdk/server` 取身份目录，调用既有的 `createXxxServerModule()`（仍是唯一构造实现）后 `installXxxModule(module)`，**返回真实模块实例**。

**二、需审核的取舍（本片自行裁定，理由与触发条件）**

1. **四处「收窄 access-control 实例」的代码各写一份**（`requireAccessControlSuite`，每处 8 行，报错文案带包名前缀）。
   不抽到 `platform-sdk` 的硬理由：`context.modules` 的值是 `unknown`，收窄它需要「access-control 实例的形状」，
   而该形状由 `@fenix/access-control` 定义，`platform-sdk` 不得依赖 platform-impl；SDK 能提供的只有「按端口键取
   模块实例」的通用助手，那是一项**新公共契约**，超出本任务已审核的三项（§3.2 / §3.3）。
   提炼触发条件已写入 mcp 的注释：出现第二个**非 access-control** 的端口也需要同形收窄时，按当时形状评审该助手。
2. **registry 的加载图变重**：资源 manifest 为了声明 `storage` 必须**值导入**自己的资源注册文件
   （`mcp-server-resource.ts` 等，链上含 `@server/db/schema` 的表定义），绑定是值而非类型，无法用 `import type` 替代。
   已核实的爆炸半径：导入生成物的只有 `apps/server/src/bootstrap.ts` 与宿主用例，`apps/web` 侧不导入 registry
   （web 只经 `apps/web/fenix.module.ts` 提供纯元数据 Shell 描述符），因此浏览器 bundle 不受影响；
   `architecture:check`（2234 files）与 `check:dependencies`（2386 modules，0 新增违规）均确认无越界边。
3. **资源包 `create` 内自行 `installXxxModule` 且不登记 cleanup**：装配结果只有 facade / service / repository，全是
   无连接、无句柄的普通对象，进程退出不需要释放；`resetXxxModule` 仍只服务测试。这样 1.5f 删除宿主手写装配后
   读取点 `getXxxModule()` 不会出现「无人写入」的窗口。
4. **`ServerRouteHost` 在本片没有消费方**：按 §3.3 它属于「与路由贡献同时定型」的契约，本片先定型接口与
   `order` 排序，实际分派与各包 `src/server/assembly.ts` 收窄留给 1.5e（本片不写无人使用的 adapter）。
5. **端到端真实 profile 装配不在本片**：宿主用例只断言「registry 的声明集合 = 四个受控资源绑定」，
   真正用 `ce.json` 跑通 `create` 全链（含 access-control 汇总绑定后建立查询）归 1.5f 的接线验证。
6. **`dependsOn` 不得写 `access-control`** 这条约束同时写进两侧注释，并由既有门禁长期守护：
   资源 manifest 静态导入的是自己的注册文件，若哪天有人把 `access-control` 写进 `dependsOn`，
   `generate:module-registry` 的反向校验（`assertDependsOnComplete`）会以「已登记越界边不得编码成装配依赖」失败。

**三、测试**

| 文件 | 用例 | 断言要点 |
| --- | --- | --- |
| `apps/server/src/__tests__/bootstrap.test.ts`（+2） | 工厂读到本次装配的全部声明 | `seenDeclarations` = 拓扑序全集；access-control 先构造却已拿到 mcp 声明的 `mcp_server` 绑定——「先装配授权、再装配资源模块」由此成立 |
| 同上 | 贡献按 `order` 升序稳定排序后挂载 | `["identity.primary", "access-control.primary", "identity.fallback"]`（order 100 的兜底最后） |
| `apps/server/src/__tests__/module-assembly.test.ts`（+1） | 受控资源 manifest 各自声明存储绑定 | 真实 registry 汇总出的 `resourceType` 排序后 = `["agent_config", "mcp_server", "provider", "skill"]` |
| `apps/server/src/__tests__/module-assembly.test.ts`（改） | — | 新增 `contractManifests: readonly ModuleManifest[]` 契约视图：生成物的 `as const satisfies` 保留的是各 manifest 字面量类型，联合类型上访问不到只有部分模块声明的可选字段 |
| `packages/platform/access-control/src/__tests__/module-assembly.test.ts`（新，3 例） | 真实例 / 绑定从声明收集 / 基础设施未初始化即报错 | 真实例是 `DefaultAccessControl` 与 `ColumnResourceScopeStore`；未声明绑定的资源报「资源 not_declared 未注册存储绑定，无法解析归属范围」（不静默放宽） |
| 四个资源包 `src/__tests__/module-assembly.test.ts`（新，各 2 例） | 真实例 + 装入进程级槽位 / 端口缺失即报错 | `module.resource === xxxResource` 且 `getXxxModule() === module`；缺端口抛「access-control 模块未提供 accessControl / scopeStore / authorizedQuery」 |
| `mcp/src/__tests__/mcp-source-migration.test.ts`、`skill/src/__tests__/skill-source-boundary.test.ts`（改） | — | 源码边界断言随 create 形态改写（新增 `create: (context) => import("./src/module").then((module) => module.createXxxModule(context))`，并断言返回真实模块类型的签名行） |

**四、验证证据**

定向：`bun test packages/platform/platform-sdk/src/__tests__/ packages/platform/access-control/src/__tests__/` 79 pass / 0 fail；
`mcp` + `skill` 359 pass、`agent-config` + `model-management` 429 pass；
`bootstrap.test.ts` 6 pass、`module-assembly.test.ts` 5 pass；根 `tsc --noEmit` 无输出；
`generate:module-registry --check` ✓（17 个 manifest）；`architecture:check` ✓（2234 files / 11 rules / 27 例外）；
`check:dependencies` ✓（2386 modules / 12 例外 / 0 新增违规）。

全量：`env -u ANTHROPIC_MODEL bun run precheck` → `All passed (122696ms)`。server-and-script-tests
**762 pass / 0 fail**（较 1.5c-8 的 759 多 3，即本片新增的 `bootstrap.test.ts` +2 与宿主 `module-assembly.test.ts` +1，
无既有用例减少）；package-tests **7312 pass / 2 skip / 0 fail**（较 1.5c-8 的 7301 多 11，即 access-control 3 +
四个资源包各 2）；web-app-tests 946 pass / 0 fail；其余九步（format / import-sort / module-registry /
architecture / 三项 tsc / dependency-boundaries / lint）全部通过。

**非确定性失败记录**（与本片改动无关，留证）：本片第一次全量 `precheck` 的 package-tests 步骤报
**79 fail / 7233 pass**，日志尾部可见的失败集中在 `packages/platform/identity/web/__tests__/organization-invite-dialog.test.tsx`
的 DOM 断言（`container.querySelector("button")` 返回 `null`），同步骤耗时由常态 52s 涨到 147s；另跑
`bun test packages/platform/identity/web/` 为 12 pass / 0 fail。第二次重跑时该步骤被 `scripts/ci.ts` 的 300s
硬超时终止（实测 417282ms，无汇总输出）；同期 `ps` 显示机器上另一个 bun 进程持续占 CPU（`%CPU` 63、已运行 7 分钟）。
负载回落后的第三次重跑即上面这条全绿结果。判断：与装配契约改动无关的负载型非确定性失败，故不视为本片回归，
但重试证据留此备查。

**五、遗留**

- 宿主在装配后**读取 access-control 实例**的路径未在本片确定（`BootstrapResult.instances` 尚未经
  `bootstrapServerAssembly` 暴露给 `main.ts`）：1.5f 接线时按 §3.1 的「只接管权限装配」范围定，候选是
  资源包同形的进程级槽位。
- `platform-sdk/src/server.ts` 的 `ServerRouteHost` 与 `contributions` 的实际消费方集中在 1.5e。

### 1.5e-1 prod-view 试点（2026-09-21）

分片行原文：「路由 contributions 声明：**先试点 `prod-view`**（2 个 web 路由、叶子模块、已在包内），
打通「包声明 → 宿主挂载」端到端；再逐包铺开其余 12 个有路由的包」，判据「每个包的 `routes/web/index.ts`
挂载点减少一处；试点片后 `precheck` + 手工启动验证」，前置 1.5d。

**一、【需审核】新增第 5 项契约：`ModuleContribution.slot`**

1.5d 定型的路由贡献形状是 `(host) => 路由实例`，但没有回答「挂到宿主的哪一面」。这不是可选细节：
资源包内部的路径是**相对形式**（`/prod-views/:id/load`），最终 URL 前缀由宿主聚合实例决定，`/web` 与
`/web/config` 是两个独立聚合——prod-view 的 2 条路由分属两者，挂错面等于整组端点前缀错位，而宿主侧的
校验（槽未知 / 未返回 Elysia）发现不了这件事。

落地：`ModuleContribution` 增加 `readonly slot?: string`（默认 `"app"`），取值是**宿主自定义的字符串**，
platform-sdk 不认识具体槽位、只负责透传。宿主侧 `bootstrap/route-contributions.ts` 维护「槽名 → 聚合
实例」映射，未接线的槽名当场报错。这是对已审核的 §3.3 的**扩大**（原裁定只覆盖贡献的形状与 `order`），
故在此单列待审。

**二、落地清单**

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 契约 | `platform-sdk/src/assembly/module-manifest.ts` | `ModuleContribution.slot`（第 5 项契约，见上） |
| 宿主协议面 | `apps/server/src/bootstrap/route-host.ts`（新） | `ServerRouteHost` 的唯一实现，七字段一次填满 |
| 贡献登记 | `apps/server/src/bootstrap/route-contributions.ts`（新） | `mountServerRouteContribution` / `takeRouteContributions(slot)` / 测试用 `resetRouteContributions` |
| 包内装配 | `packages/resources/prod-view/src/server/assembly.ts`（新） | 从 `ServerRouteHost` 收窄出 `authGuardPlugin`，暴露两个路由工厂 |
| 包声明 | `packages/resources/prod-view/fenix.module.ts` | 两条 `app-route` 贡献（`slot: "web"` / `"web-config"`，`value` 为惰性 `import()`） |
| 宿主聚合 | `apps/server/src/routes/web/index.ts`、`routes/web/config/index.ts` | 两个聚合改为工厂，接收本槽的贡献数组并在末尾 `.use([...])` |
| 宿主接线 | `apps/server/src/main.ts` | `wirePermissions` 段替换为 `bootstrapServerAssembly({ mountContribution })`；app 链改 `.use(createWebApp({ web: takeRouteContributions(...), webConfig: ... }))` |
| 发布组合 | `deploy/assembly/ce.json` | `resources` 填实为 7 项（含依赖闭包） |
| 启动序 | `apps/server/src/bootstrap/startup-sequence.ts` | `wirePermissions` 类型放宽为 `() => Promise<unknown>`（装配返回结果宿主暂不需要） |

**三、需审核的取舍**

1. **判据「打通端到端」迫使 `main.ts` 提前接入 registry**（原本计划归 1.5f）。理由：不接 registry 就
   只能测「登记函数本身」，无法证明「真实 ce.json + 真实模块工厂产出的路由真的进了槽」。做法上仍守
   §3.1 的最小范围——只替换 `wirePermissions` 一段，其余启动序、服务装配、HTTP 路由序列一律不动。
   替代方案（在用例里手工调 `bootstrapServerAssembly` 已部分采用）不能替代宿主真实接线，故两者都做。
2. **`route-host.ts` 七项一次填满**而不是「谁先迁入谁先加」：七项实现都已存在且是同一份进程级实例，
   逐片追加会让每迁一个包改一次宿主装配面。代价仅是几行对象字面量。
3. **槽名 `"web"` / `"web-config"` 由宿主定义**，包只写字符串字面量。包因此对宿主槽名有软耦合，但没有
   更好的选择：槽名是包与宿主之间唯一的约定面，且必须能在 manifest（静态描述符）里表达。
   `"config"` 之类更短的名字与 `/web/config` 的对应关系更弱，故取路径名。
4. **`ce.json` 的 `resources` 填实为 7 项**：PROD_VIEW 之外，knowledge / mcp / memory / skill /
   agent-config / model-management 是按 profile 依赖闭包（agent-config 依赖 knowledge/mcp/memory/skill；
   mcp 依赖 knowledge；model-management 依赖 agent-config）反推的必需项。不填实则端到端装配只有
   identity / access-control / agent-runtime，prod-view 的 contributions 也观察不到真实依赖链。
   副作用：这些模块的 `create` 在装配期被**再调一次**——identity 的目录与 agent-runtime 的实例协调器
   都是幂等读取（`initializeApplicationInfrastructure` 已在更早阶段初始化），无副作用；1.5f 删除宿主手写
   装配后自然唯一。
5. **默认槽 `"app"` 暂无读者**：1.5f 接顶层 app 槽前，声明不带 `slot` 的路由贡献会以「未知聚合槽 "app"」
   报错，而不是被静默丢弃。这条有专门用例锁定。
6. **`resetRouteContributions()` 只为测试**：槽位是进程级单例，真实进程装配只发生一次；没有它跨用例会
   累积上一例的路由。已按「仅服务测试」标注，与 `resetXxxModule` 同类。

**四、测试**

| 文件 | 用例数 | 断言要点 |
| --- | --- | --- |
| `apps/server/src/__tests__/route-contributions.test.ts`（新） | 8 | 按槽分组 / 空槽返回空数组 / 非 `app-route` 跳过 / 未知槽报错 / 默认槽 `"app"` 报错 / value 非函数报错 / 构造函数未返回 Elysia 报错 / **真实 profile 端到端**（真实 ce.json + 生成 registry + 10 个真实模块工厂 → 断言 web 槽 1 条、web-config 槽 5 条路径） |
| `packages/resources/prod-view/src/__tests__/prod-view-contributions.test.ts`（新） | 4 | manifest 两条贡献的 `[id, kind, slot]` / web 槽产出 `/prod-views/:id/load` / web-config 槽含 `/config/prod-views` 与 `/config/prod-views/:id` / assembly 收窄结果与贡献一致 |
| `apps/server/src/__tests__/config-integration.test.ts`、`agent-platform-api-reference.test.ts`（改） | — | 聚合工厂化的调用面适配（`createWebConfigApp([])`、`createWebApp({ web: [], webConfig: [] })`） |
| `apps/server/src/__tests__/access-control-bootstrap-order.test.ts`（改） | — | `wirePermissions` 改传 `Promise<unknown>` 后注释同步为「跑的是 registry 装配」 |

端到端断言用 `toEqual` 而非 `toContain`：1.5e 每迁入一个包这里就多一条路径，迁移进度因此有一份可执行的
镜像，漏挂不会静默通过。

**五、验证证据**

定向：`bun test apps/server/src/__tests__/route-contributions.test.ts .../module-assembly.test.ts .../bootstrap.test.ts`
19 pass / 0 fail；`bun test apps/server/src/__tests__/` 633 pass / 0 fail；prod-view 4 pass；三个受影响用例文件均通过；
根 `tsc --noEmit` 无输出；`generate:module-registry --check` ✓（17 个 manifest）；`architecture:check` ✓
（2239 files / 11 rules / 27 例外）；`check:dependencies` ✓（2391 modules / 12 例外 / 0 新增违规）。
全量：`env -u ANTHROPIC_MODEL bun run precheck` → `All passed (86961ms)`。server-and-script-tests
**770 pass / 0 fail**（较 1.5d 的 762 多 8，即新增的 `route-contributions.test.ts` 8 例，无既有用例减少）；
package-tests **7316 pass / 2 skip / 0 fail**（较 1.5d 的 7312 多 4，即 prod-view 的 4 例）；
web-app-tests 946 pass / 0 fail（无前端改动，与 1.5d 持平）；其余九步全部通过。

**手工启动验证未完成**：本机无 PostgreSQL（`bun run dev` 在 `initDb` 阶段 `ECONNREFUSED 127.0.0.1:5432` /
`::1:5432`，失败点早于装配，与本片改动无关），OrbStack docker daemon 未运行且未安装 `psql` / `pg_isready`，
无法在本环境补做。需要在可用 DB 的环境补跑 `bun run dev` + `/health` + prod-view 两个端点；端到端装配
在测试中以真实 profile 覆盖（见上表第 8 条用例），但**进程级启动路径未实测**，列为遗留。

**六、遗留**

- 手工启动验证（`bun run dev` + `/health`）待有 DB 的环境补做。
- 1.5e-2：其余 12 个有路由的包逐包铺开，每迁一包更新 `route-contributions.test.ts` 的真实端到端断言。

### 1.5e-2a `/web/config` 面清零 + 发布组合全量启用（2026-09-21）

分片行原文（1.5e 后半段）：「再逐包铺开其余 12 个有路由的包」，判据「每个包的 `routes/web/index.ts`
挂载点减少一处；试点片后 `precheck` + 手工启动验证」。

本片把 `/web/config` 聚合面的 6 个手写挂载点全部迁到贡献声明，`routes/web/config/index.ts` 因此**只剩
`.use([...contributedRoutes])` 一行挂载**——这是 1.5e 的第一个「聚合面清零」，也为 `web` 面（23 个手写
挂载点）的迁移定下可复制的形状。

**一、【需审核】`deploy/assembly/ce.json` 的 `resources` 提前填实为全量 13 个**

1.5e-1 只填了 7 项（prod-view 的依赖闭包）。本片一迁 sandbox 就暴露了问题：sandbox 不在 profile 里，
它的贡献没有消费方，而宿主手写挂载已按判据删除 → `/web/config/sandbox-pools` **静默消失**。

裁定：填成全量发布组合的 13 个资源模块（`agent-config` / `channel` / `knowledge` / `machine` / `mcp` /
`memory` / `model-management` / `observer` / `prod-view` / `sandbox` / `skill` / `task` / `workflow`），
理由与影响：

- **「启用范围先于迁移」是迁移判据的前提**：判据要求「挂载点减少一处」，若被迁的包未启用，减少的挂载
  点不会由贡献补回，迁移即回归。
- **CE 单机发布的语义就是全部能力**：13 个模块都是真实交付物，不存在「只装子集」的部署形态。
- **提前完成了 1.5f 的一项判据**（「填实 `deploy/assembly/ce.json` 的 `resources`」）。1.5f 余下的判据
  （`grep '@fenix/' apps/server/src/main.ts` 归零、删除 `no-new-handwritten-registry` 规则与
  `handwrittenRegistryBaseline`）不受影响。
- **副作用（列为遗留）**：`channel` / `machine` / `observer` / `sandbox` / `task` / `workflow` 这 6 个
  模块的 `create` 是 1.5d 之前的形式（`() => import("./src/module").then(m => m.createXxxModule())`，不
  接收 `ModuleFactoryContext`、不 `installXxxModule`、不返回给宿主消费），本片起它们**首次在装配期被
  执行**。测试全绿说明无失败路径；但「构造出的实例无人读取」与「create 是否有装配期副作用」需要
  1.5f 的手工启动验证确认，届时它们要与 1.5d 已改的四个受控资源包同形。

**二、本片迁入的包与端点**

| 包 | 贡献 id | 槽 | 端点数 |
| --- | --- | --- | --- |
| `model-management` | `model-management.web-config-providers` | `web-config` | 8 |
| `model-management` | `model-management.web-config-models` | `web-config` | 3 |
| `sandbox` | `sandbox.web-config` | `web-config` | 1 |
| `agent-config` | `agent-config.web-config-agents` | `web-config` | 7 |
| `skill` | `skill.web-config` | `web-config` | 8 |
| `mcp` | `mcp.web-config` | `web-config` | 10 |

每包新增 `src/server/assembly.ts`：把 `ServerRouteHost` 收窄为该包路由的依赖类型（`unknown` → 具体端口，
收窄只在包内做一次，理由见 §3.3）；`fenix.module.ts` 用 `slot: "web-config"` 声明惰性构造函数
（`value: (host) => import("./src/server/assembly").then(...)`，惰性理由同 `create`：registry 会被大量
位置导入，不能在索引层把 Elysia 拖进模块图）；包内注释同步改写（原先写的都是「不声明 `contributions`」）。

**三、本片未做 / 明确取舍**

1. **`web` 面的 23 个手写挂载点本片不动**（identity 2、agent-runtime 3、agent-config 4、channel 1、
   knowledge 1、machine 3、memory 1、model-management 2、task 1、workflow 5；`branding` 是宿主自有文件，
   永远留在挂载序列里）。批 1.5e-2b 起继续，理由：这 23 个里有 2 处需要扩 `ServerRouteHost`
   （`verifyEnvironmentOwnership` 给 model-management 的 peri 任务详情、`rotateCallerApiKey` 给
   agent-config 的 meta-agent），是契约面的改动，应与它服务的迁移片同批评审。
2. **不为每个包复制一份 prod-view 的包内贡献测试**。宿主 `route-contributions.test.ts` 的真实 profile
   用例已经用 `toEqual` 精确锁定「每个包贡献了哪些路径、进了哪个槽」——slot 写错会表现为路径出现在错误的
   槽并当场失败；包内再写一份是同一事实的第二份拷贝。prod-view 那份（4 例）保留：它是试点期宿主接线
   完成**前**的自证工具，且额外覆盖了「`assembly.ts` 的收窄结果与贡献一致」这一点（该文件是唯一断言
   assembly 导出的地方）。
3. **新增 `apps/server/src/test-utils/web-config-routes.ts`**：给「需要真实 `/web/config` 路由但不关心
   装配语义」的用例（`config-integration.test.ts`、`agent-platform-api-reference.test.ts`）提供各包路由
   工厂 + 宿主端口实现的集合。必须这么做而不是跑 `bootstrapServerAssembly` 的原因：装配要求基础设施已
   初始化，而 `initializeApplicationInfrastructure` **每进程只允许调用一次**，测试进程里真实装配由
   `route-contributions.test.ts` 独占（preload 刻意不初始化基础设施，见 `test-utils/setup-mocks.ts`）。
   helper 的端口取宿主真实实现而非替身：这两个用例断言的是「协议层把资源 Facade 的输出映射成视图」。
4. **`ce.json` 的 `resources` 用字母序**而不是拓扑序：拓扑序由 registry 的 `visit()` 按 `dependsOn`
   决定，profile 里的顺序只表达「启用哪些」，字母序在 13 项时比人工维护的拓扑序更不容易写错。

**四、测试**

| 文件 | 改动 | 断言要点 |
| --- | --- | --- |
| `apps/server/src/__tests__/route-contributions.test.ts` | 真实 profile 用例扩到 42 条 `web-config` 路径 | 每包分组列出全部路径（可执行的迁移镜像，漏挂即失败） |
| `apps/server/src/__tests__/module-assembly.test.ts` | `EXPECTED_SERVER_MODULES` 扩到 16 项（3 基础 + 13 资源） | 拓扑序：`machine` 早于 `sandbox`、`agent-config` 早于 `model-management`，不按字母序 |
| `apps/server/src/__tests__/config-integration.test.ts` | 装配来源改为 helper | 12 例行为断言不变（stub Facade 边界不变） |
| `apps/server/src/__tests__/agent-platform-api-reference.test.ts` | `webConfig` 槽改喂 helper | 文档 curl 示例全部命中真实注册路由（迁移前 29 条 `/web/config/*` 缺失） |

**五、验证证据**

定向：`bun test apps/server/src/__tests__/` **633 pass / 0 fail**；`sandbox` + `skill` + `mcp`
**669 pass / 0 fail**；`agent-config` + `model-management` **633 pass / 0 fail**；根 `tsc --noEmit` 无输出；
`architecture:check` ✓（2245 files / 11 rules / 27 例外）；`check:dependencies` ✓（2397 modules / 12 例外 /
0 新增违规）；`generate:module-registry --check` ✓（17 个 manifest）。

全量：`env -u ANTHROPIC_MODEL bun run precheck` → `All passed (85648ms)`。server-and-script-tests
**770 pass / 0 fail**、package-tests **7316 pass / 2 skip / 0 fail**、web-app-tests 946 pass / 0 fail ——
三项用例数与 1.5e-1 持平（本片只改既有断言的内容与装配来源，未新增用例）。

**六、遗留**

- `web` 面 23 个挂载点的迁移（1.5e-2b），含 `ServerRouteHost` 扩两字段（见三.1）。
- 6 个「1.5d 之前形态」的 `create` 要在 1.5f 与四个受控资源包同形（见一.4）。
- 手工启动验证仍待有 DB 的环境补做（同 1.5e-1）。

### 1.5e-2b-1 `web` 面 8 包迁入（2026-09-21）

本片把 `web` 面的 17 条包路由迁到贡献声明（按包计：identity 2、agent-runtime 3、knowledge 1、memory 1、
channel 1、machine 3、task 1、workflow 5；prod-view 1 条已由 1.5e-1 迁走）。宿主 `routes/web/index.ts` 的
手写挂载由 26 条降到 8 条（`branding` + config 聚合 + agent-config 4 + model-management 2；后 6 条在
1.5e-2b-2 迁走）。

**一、基础模块同样声明贡献（本片新确立）**

identity 与 agent-runtime 是 `kind: identity` / `kind: agent-runtime` 的基础模块，此前没有贡献面。装配的
mount 阶段（`bootstrapModules` 的 `orderContributions`）遍历的是 profile 解析出的**全部**模块，不区分类别，
因此它们与资源包走同一条接线——本片用它们的 5 条路由验证了这一点。两条约束写进各自 manifest 注释：

- 基础模块的 `create` 必须返回实例（否则 `bootstrapModules` 抛「基础模块 X 工厂未返回实例」），与贡献面无关；
- 贡献的 `slot` 语义与资源包完全一致，宿主侧不认识包类别。

**二、`module` 贡献的粒度：按路由组，不按包**

一个包有几条路由组就声明几条贡献（workflow 5 条、machine 3 条、identity 2 条），而不是「一包一条贡献、
内部再挂多个路由实例」。理由：贡献是「怎么造这条路由」的声明，粒度与路由工厂一一对应——逐条可直接落到
包内的一个工厂函数，未来某条路由需要换槽或换 `order` 时不必拆包。代价是 `Object` 数量变多（13 个包共
25 条贡献），由 `route-contributions.test.ts` 的 `toEqual` 全列表守护。

**三、`/web` 面的挂载顺序在迁移前后一致（已核对）**

Elysia 的同路径冲突取决于挂载顺序，而贡献顺序是「拓扑序 + manifest 内声明序」，与迁移前手写序列**不
同**（手写序列是人工排的）。核对结果：`/web` 面唯一的前缀重叠是 agent-runtime 的 `/environments/*` 与
machine 的 `/environments/:id/fs/*`，两者段数不同、不构成歧义；`model-management` 的
`/agents/:environmentId/sessions/:sessionId/peri-tasks/:taskId/detail` 与 agent-config 的
`/agent-sites/*`、`/agent-generation` 前缀不同。因此本片不引入 `order`（没有兜底或通配贡献）。
`route-contributions.test.ts` 的 139 条 `web` 槽断言按装配收集顺序列出全部路径，任何顺序或内容的漂移都会
表现为断言失败。

**四、测试 helper 改名扩容**

`test-utils/web-config-routes.ts` → `test-utils/web-routes.ts`，新增 `createTestWebRoutes()`（`web` 面 18 个
路由实例，agent-config 与 model-management 的 6 条仍由 `createWebApp` 的手写序列提供，故不在其中）。
`agent-platform-api-reference.test.ts` 的两个槽因此都拿到真实路由——迁移后它一度报 29 条文档示例缺失
（`/web/config/*`），本批又暴露出 `web` 面的缺失，两次都是同一个原因：聚合面改由贡献提供后，用例不能再用
空槽构造。

**五、验证证据**

定向：`bun test apps/server/src/__tests__/` **633 pass / 0 fail**（含 `route-contributions.test.ts` 的
139 + 42 条路径断言）；`platform/identity` + `agent-runtime` + `channel` + `knowledge`
**1529 pass / 0 fail**；`memory` + `task` + `workflow` + `machine` **1700 pass / 0 fail**；根
`tsc --noEmit` 无输出。

全量 `env -u ANTHROPIC_MODEL bun run precheck` 全绿：`All passed (84971ms)`，format / import-sort /
module-registry / architecture / tsc(server, web, app-skeletons) / dependency-boundaries / lint 全过，
server-and-script-tests **770 pass / 0 fail**、package-tests **7316 pass / 2 skip / 0 fail**、
web-app-tests **946 pass / 0 fail**。

**六、遗留**

- `web` 面剩 agent-config 4 条与 model-management 2 条（1.5e-2b-2），同批扩 `ServerRouteHost` 的
  `rotateCallerApiKey` 与 `verifyEnvironmentOwnership` 两个端口；完成后宿主 `routes/web/index.ts` 只剩
  `branding` 一项手写挂载。

### 1.5e-2b-2 `/web` 手写序列清零（2026-09-21）

本片是 1.5e 的最后一片：agent-config 的 4 条（`/web/sidebar-config`、`/web/agent-sites`、
`/web/agent-generation`、`/web/meta-agent/ensure`）与 model-management 的 2 条（`/web/model-gateway`、
`/web/agents/:environmentId/sessions/:sessionId/peri-tasks/:taskId/detail`）迁入 `web` 槽。

**一、`routes/web/index.ts` 的手写序列清零**

只剩两条手写挂载，且都不属于任何模块：`branding`（控制台品牌素材）与 `/web/config` 聚合实例。`createWebApp`
现在只有三行 `.use()`，本文件不再 import 任何 `@fenix/*` 包——`web` 面的包路由全部来自槽。判据「每个包的
`routes/web/index.ts` 挂载点减少一处」的累计结果：1.5e 起点（`6f39e4bdc`）该文件的 `.use()` 为 26 条
（24 条包路由 + `branding` + config 聚合），现状 2 条。24 条包路由里含 identity 2 条与 agent-runtime 3 条，
即两个基础模块与资源包走的是同一条装配接线（见 1.5e-2b-1 §一）。

**二、`ServerRouteHost` 扩两字段【需审核】**

`verifyEnvironmentOwnership`（peri 任务详情校验 Environment 归属）与 `rotateCallerApiKey`（meta agent
轮换调用方 API Key）。两者在 1.5e-1 试点时被有意排除在「七项一次填满」之外（见 §三.1 遗留），本片与消费
路由同批加，字段数 7 → 9。

必须走宿主端口而不是包内自建：`apikey` 表属 `@fenix/identity`、`Environment` 表属 `@fenix/agent-runtime`，
资源包对二者都没有合法依赖（§2.3 矩阵）。宿主侧 `verifyEnvironmentOwnership` 取自
`services/resource-module-ports.ts`，`rotateCallerApiKey` 直接取 `@fenix/identity/server`。

需审核的点：`ServerRouteHost` 的定位是「宿主协议 adapter 面」，而 `rotateCallerApiKey` 是一个**业务动作**
而非协议适配——放进这个面意味着 platform-sdk 的契约里出现一条语义偏业务的条目。替代方案是让 meta-agent
路由走 `ModuleFactoryContext` 或另开一个「宿主业务能力」契约面，两者都要新增机制；本片按「沿用既有契约、
不新增机制」处理，请裁定是否可接受。

**三、挂载顺序变化（已核对）**

迁移前这 6 条在槽外、统一早于 `slots.web`；迁移后按拓扑序落在槽内：agent-config 在 memory 之后 / channel
之前，model-management 在 machine 之后 / prod-view 之前。逐条核对前序路由有无前缀遮蔽——identity
（`/api-keys`、`/organizations`）、agent-runtime（`/sessions`、`/environments`、`/instances`）、knowledge
（`/knowledgeBases`）、memory（`/hindsight`）、channel（`/channels`）、machine（`/environments/:id/fs`、
`/file-events/`、`/registry`）与这 6 条的 `/sidebar-config`、`/agent-sites`、`/agent-generation`、
`/meta-agent`、`/model-gateway`、`/agents/:environmentId/...` 均无前缀重叠；agent-sites 内部唯一通配
`ALL /agent-sites/apps/:id/api/*` 也在自己的前缀内。因此本片同样不引入 `order`。

**四、`test-utils/web-routes.ts` 顺带修正两处漂移【需审核】**

1. `createTestWebConfigRoutes()` 漏了 prod-view 的 `/config/prod-views`（1.5e-1 试点迁入时未回补），且排列
   顺序是迁移前的宿主手写序而不是装配收集序——本片按装配收集序补齐为 7 个路由实例（mcp、skill、
   agent-config、model-management×2、prod-view、sandbox）。
2. `createTestWebRoutes()` 补入本片迁入的 6 条（现 24 条），顺序按装配收集序。

这两处漂移此前不会让任何用例失败（helper 只服务「协议层映射」类断言，这些用例里不存在冲突路径），但会让
「helper == 生产路由面」的假设失真——缺 prod-view 配置面时，未来依赖 `/web/config/prod-views` 的用例会得到
假 404。是否需要为 helper 与生产的这种漂移加一条自动守护（例如用例里断言两边路径集合相等）**待裁定**：真实
装配由 `route-contributions.test.ts` 独占，跨用例比对需要另开机制；本片只修内容，不加守护。

**五、验证证据**

`route-contributions.test.ts` 的 `web` 槽自 139 条增至 158 条（agent-config 17 + model-management 2），
`web-config` 槽 62 条路径不变。断言 diff 精确给出 19 条新路径与插入位置，照此补齐后 8 pass。
`bun test apps/server/src/__tests__/` **633 pass / 0 fail**；`agent-config` + `model-management` +
`platform-sdk` **687 pass / 0 fail**；根 `tsc --noEmit` 无输出。

全量 `env -u ANTHROPIC_MODEL bun run precheck` 全绿：`All passed (84922ms)`，format / import-sort /
module-registry / architecture / tsc(server, web, app-skeletons) / dependency-boundaries / lint 全过，
server-and-script-tests **770 pass / 0 fail**、package-tests **7316 pass / 2 skip / 0 fail**、
web-app-tests **946 pass / 0 fail**。

**六、遗留**

- `/web/site/deploy` 与 `/app-*` 兜底（agent-config 的 `agent-sites-proxy`）仍在 `main.ts` 顶层手写挂载，
  归 1.5f 的顶层 `app` 槽。
- 手工启动验证已由 1.5e-3 补做（该节同时关掉 1.5e-1 / 2a / 2b-1 三处遗留里的同一项）。
- 待裁定项已在 §二、§四 标注：`ServerRouteHost` 是否应承载 `rotateCallerApiKey` 这类业务动作，以及是否为
  `test-utils/web-routes.ts` 与生产路由面的漂移加自动守护。

### 1.5e-3 手工启动验证（2026-09-21）

分片表 1.5e 判据里的「手工启动验证」至此补做完成，同时关掉 1.5e-1、1.5e-2a、1.5e-2b-1 三处「无 PostgreSQL
未完成」的遗留。前置事实：本机此前没有可用 DB（OrbStack 未运行、无 `psql`/`pg_isready`），这四项一直挂着。

**一、环境选择【需审核】**

为跑验证启动了 OrbStack（本机唯一的容器运行时，此前未运行）。数据库**没有**复用已在 5432 上的
`fenixagent-postgres-1`——那是另一个检出（`/Users/liyuan/Work/FenixAgent`）的开发库，跑 `db:migrate`
会改动它的数据；改为起一次性容器 `postgres:16-alpine` 并映射到 **55432**：

```
docker run -d --name aos-sandbox-pg-verify -p 55432:5432 \
  -e POSTGRES_USER=rcs -e POSTGRES_PASSWORD=rcs -e POSTGRES_DB=rcs postgres:16-alpine
DATABASE_URL=postgres://rcs:rcs@127.0.0.1:55432/rcs bun run db:migrate   # 全链应用成功
```

副作用两条：启动 OrbStack 会让它配置的 `restart: unless-stopped` 容器（litellm、opensandbox 等）随之启动；
验证容器与服务进程已在收尾时删掉/停掉。

**二、启动结果：成功，无装配期错误**

`bun run apps/server/src/main.ts`（`DATABASE_URL` 指向上面的验证库）启动到
`Listening on 0.0.0.0:3000 (baseUrl: http://localhost:3000)`。日志中先有 `Database initialized`、三条
data migration（`migrate-agent-config-model-id`、`migrate-skill-storage-by-organization`、
`access-control/20260919-backfill-resource-visibility`）完成、`System admin ready`、内置 Skill 同步与
custom tools registry ready。**全文无 ERROR，也没有「未知聚合槽」「没有返回 Elysia 实例」「基础模块 …
未返回实例」**——即 1.5e 全量迁入贡献面后，装配期与启动序都正常。

**三、端点可达性探测（证明「贡献真的挂上去了」）**

探测有个必须说明的对照：**未注册的路径不会 404**，静态兜底会把它们交给 SPA 返回 200
（`/web/nope`、`/web/config/nope`、`/api/nope` 实测均为 200）。因此判据是「路由自己的响应」——被守卫拦下的
401、schema 校验失败的 400、公开端点的真实负载，三者都只能由真实注册的路由产生。

| 探测 | 结果 | 说明 |
|---|---|---|
| `GET /health` | 200 | 服务存活 |
| `GET /web/sidebar-config/` | 200 `{"success":true,"data":{"hiddenTabs":[…]}}` | 公开端点返回真实配置 |
| `GET /web/prod-views/anything/load`、`/web/api-keys`、`/web/environments`、`/web/knowledgeBases`、`/web/hindsight/status`、`/web/channels/bindings`、`/web/environments/x/fs`、`/web/registry/machines`、`/web/tasks/v2`、`/web/workflow-defs` | 401 | 1.5e-1 / 2b-1 迁入的 `web` 面，守卫拦住 |
| `GET /web/agent-sites/apps`、`GET /web/agents/e1/sessions/s1/peri-tasks/t1/detail`、`POST /web/meta-agent/ensure` | 401 | 2b-2 迁入的三条守卫路由 |
| `GET /web/model-gateway/p1/usage` | 400 `startAt: Invalid input: expected string`、`POST /web/agent-generation` | 400 | 2b-2 迁入的两条，schema 校验已执行 |
| `GET /web/config/{mcp,skills,agents,models,providers,prod-views,sandbox-pools}` | 全 401 | `web-config` 槽 7 个实例全部在 |

其中 `sandbox-pools` 是 1.5e-2a 那次「路由静默消失」的主角，本次确认真实启动下已由贡献补回
（此前只有 `config-integration.test.ts` 的替身路径能证明它有响应）。

**四、遗留**

- 本节的验证只覆盖「注册与装配」，没有覆盖需要登录态的端到端业务流（登录、Agent 会话、workflow 执行）——
  那些属于 1.5f/1.8 的证据范围。
- 验证库是一次性的，未保留；如需复现按 §一 的命令重建。

### 1.5f-1a `api` 槽落地：17 条 `/api/*` 手写挂载清零（2026-09-21）

分片表 1.5f 的第一片。判据原文要求 `grep '@fenix/' apps/server/src/main.ts` 归零，与用户裁定合并后的执行口径是
**「只要求模块与协议路由归零」**，且**分批**：本片只做协议路由（`api` 槽），顶层 `app` 槽与约 30 处生命周期/启动
编排调用留下两片。`@fenix/logger`（`interceptConsole()` 必须最先执行）与 `@fenix/platform-sdk/server`
（`initializeApplicationInfrastructure` / `registerIdentityDirectory`）的 import 按裁定保留。

**一、做了什么**

`api` 槽（`bootstrap/route-contributions.ts` 的 `API_SLOT = "api"`）+ 聚合实例
`apps/server/src/routes/api/index.ts` 的 `createApiApp({ api })`。11 个包各自在 `src/server/assembly.ts` 里加一个
收窄函数（observer 此前没有 `assembly.ts`，本片新建），manifest 加 `slot: "api"` 的 `app-route` 贡献：

| 包 | 贡献 | 守卫 |
|---|---|---|
| identity | `createIdentityApiSystemRoutes`（`/api/system/users`、`/organizations`、`/api-keys`，14 条） | system API |
| agent-runtime | `createAgentRuntimeApiInstanceRoutes`、`createAgentRuntimeOpenaiChatRoutes` | 会话（前者的实例接入另需 `logError`） |
| knowledge / mcp / skill / agent-config / machine / workflow | 各 1 条 | 会话 |
| model-management | `/api/models`（会话）、`/api/system/model-gateway`（system API） | 两种 |
| observer | `/api/system/{observer,logs,people-tree}`，3 条 | system API |
| sandbox | `/api/system/{sandbox-pools,sandbox-instances}`、`-cluster`、`-server`，三个工厂 | system API |

`main.ts` 的 17 条 `.use(createApi…Routes({…}))` 换成一条
`.use(createApiApp({ api: takeRouteContributions(API_SLOT) }))`，相应 import 与只服务于它们的
`systemApiAuthPlugin` / `logError` 宿主导入一并删除。`route-contributions.test.ts` 的真实 profile 断言新增
`API_SLOT` 分组（89 条路径，`toEqual` 全量镜像）。

**二、【需审核】`ServerRouteHost` 第三次扩面：`logError`**

10 个端口分三批到位的前两批见 1.5d 与 2b-2 的记录；本片加第 10 项 `logError`（`/api/agents/:agentId/instances/connect`
的唯一消费方）。理由与前两批同类：它要读宿主中间件写在 request 上的 `__requestId` / `__startTime`，以及
`errorPlugin` 对 SPA 兜底与 `ValidationError` 的特判——包内没有来源，自建第二份会让同一次失败在两条日志管道里
各记一次并丢掉 requestId 关联。

需要审核的是**方向**而不是实现：`rotateCallerApiKey`（2b-2 加入）与本项都说明 `ServerRouteHost` 正在承载「宿主
能力」之外的东西。第十项之后，这个接口里有 5 个纯守卫/取数端口（`authGuardPlugin`、`systemApiGuardPlugin`、
`authenticateRequest`、`environmentLookup`、`verifyEnvironmentOwnership`）、2 个身份族偏好端口、1 个密钥引用解析、
1 个业务动作、1 个日志钩子。建议的收口方式（**本片未做**，等 1.5f 收尾时一并裁定）：把「协议适配」与「宿主能力
注入」拆成两个接口，`ServerRouteHost` 只留前者。

**三、【需审核】`api` 槽的挂载顺序与手写序不同**

槽内顺序 = 装配拓扑序 + manifest 内声明序（与 `web` / `web-config` 两面同规则），因此与迁移前 `main.ts` 的
手写序有两处不同：agent-runtime 的两条（拓扑序第 3）排在 agent-config / knowledge / mcp / skill 之前；
model-management 的 `/api/system/model-gateway`（第 11）排在 observer 的 `/api/system/*`（第 12）之前。逐前缀核对
无遮蔽：`/api/agents/:agentId/*` 与 `/api/agents/{,":id"}` 段深不同；`/api/system/` 下第二段全是静态
（`users` / `organizations` / `api-keys` / `model-gateway` / `logs` / `observer` / `people-tree` / `sandbox-*`），
没有同位置的参数路由。Elysia 的 radix 匹配对静态段优先，不依赖注册顺序。

真正有风险的是**两种守卫家族进同一个实例**：会话守卫生成的 `store.actor` / `sessionAuth` 宏与系统 API 守卫的
`store.systemAuth` 在同一 app 作用域里是否互相干扰——这一点在手工验证里用真实 system key 双向证伪（见 §五）。

**四、【需审核】顶层 `app` 槽本片刻意不接线**

`READABLE_SLOTS` 仍只有 `web` / `web-config` / `api` 三项：`app` 槽的消费者（`main.ts` 根 app 的
`skillDownloadRoutes`、MCP、hooks、站点代理/兜底）留下片，读数与写数必须同批到位——先把槽名加进白名单会让
「声明了但没人取」的贡献被静默丢弃，而这条路径的失败模式恰好是「整组端点消失」，规则存在的意义就是让它当场报错。
`route-contributions.test.ts` 里「未声明 slot 的贡献拒绝装配」那条用例因此保持原样。

**五、手工启动验证（判据里的「服务可启动」）**

按 1.5e-3 的口径复跑：一次性 `postgres:16-alpine` 容器映射 **55432**（不复用 5432 上另一个检出的开发库），
`db:migrate` 全链应用成功后 `RCS_PORT=3901 bun run apps/server/src/main.ts` 启动到
`Listening on 0.0.0.0:3901`。日志 323 行，**无装配期错误**（无「未知聚合槽」「没有返回 Elysia 实例」），
唯二 ERROR 来自本节自己的探测请求（路由 schema 校验 400 与 better-auth 拒绝 system key）。

| 探测 | 结果 | 说明 |
|---|---|---|
| `GET /api/{agents,knowledge-bases,skills/,mcp,models/providers}` | 全 401 | 5 个会话守卫包 |
| `POST /api/environments/env-1/workspace/files`、`/api/agents/a-1/instances/connect` | 401 | machine / agent-runtime 的实例接入 |
| `POST /api/agents/a-1/v1/chat/completions`、`/api/workflows/wf-1/execute` | 400 `messages: expected array` / `authorization: expected string` | 路由自己的 schema 校验已执行（校验先于守卫是这两条路由的既有协议行为，本片未改） |
| `GET /api/system/{users,logs/,people-tree/,observer/acp-link,model-gateway/config,sandbox-pools,sandbox-cluster/pools,sandbox-server/servers/x/sandboxes}` | 全 401（无 token） | 7 条 system API 路由全部在位 |
| 同上三条 + `/api/system/users` 带**真实** `RCS_SYSTEM_API_KEYS` | 200 + 真实负载（sandbox 池列表、人员树、acp-link 观察树） | 系统 API 面真的能服务，不只是拦住 |
| `/api/{skills/,agents,models/providers}` 带**同一把** system key | 全 401 | 反向对照：system key 打不开会话守卫面，两种守卫家族没有混用 |
| `GET /api/nope` | 200 | 对照项：未注册路径走 SPA 兜底，不返回 404 |

验证容器与服务进程已在收尾时删除/停止；未保留可复用库。

**六、本片出现的两处清理**

- `test-utils/web-routes.ts` 改名为 `test-utils/route-faces.ts`（`git mv`）：本片起它同时提供 `/web`、`/web/config`、
  `/api` 三面的测试路由，文件名与内容不再对应；两个调用方同步改 import。`app` 面（下片）也在同一命名下。
- `@fenix/resource-observer/server` 从 `main.ts` 的 import 里完全消失（它在宿主侧的唯一用法就是那三条
  `/api/system/*` 路由）。**`scripts/architecture/exceptions.json` 的 `handwrittenRegistryBaseline` 里
  `"@fenix/resource-observer"` 一行因此成为陈旧条目**——该字段整体按计划在 1.5f 收尾片删除，本片不动它，
  以免留下「规则已删、基线还在」的中间态。

### 1.5f-1b 顶层 `app` 槽落地：7 条协议路由手写挂载清零（2026-09-21）

分片表 1.5f 的第二片，前置是 1.5f-1a（`api` 槽）。口径不变：只做协议路由，生命周期/启动编排留下片。

**一、做了什么**

`APP_SLOT = "app"` 加回 `READABLE_SLOTS`（上一片刻意不加，理由见 1.5f-1a §四——读数与写数必须同批到位），
五个包各加一个装配函数与一条 `slot: "app"` 贡献：

| 包 | 装配函数 | 贡献 id | 路由（槽内实际登记） |
|---|---|---|---|
| agent-runtime | `createAgentRuntimeAcpAppRoutes(host)` | `agent-runtime.app-acp` | `GET /acp/agents` + 4 条 WS（`/acp/ws`、`/file-ws`、`/yjs/:agentId`、`/relay/:agentId`） |
| mcp | `createKnowledgeMcpAppRoutes()` | `mcp.app-knowledge` | `ALL /mcp/knowledge` |
| skill | `createSkillDownloadAppRoutes()` | `skill.app-download` | `GET /skills/:name/download` |
| agent-config | `createAgentConfigAgentSitesProxyRoutes(host)` | `agent-config.app-site-deploy` | `ALL /web/site/deploy/:appId`、`/:appId/*` |
| agent-config | `createAgentConfigAgentSitesCompatRoutes(host)` | `agent-config.app-site-compat`（**`order: 100`**） | `ALL /*` |
| workflow | `createWorkflowStaticAppRoutes(host)` | `workflow.app-static` | `ALL /workflow-ui/`、`/workflow-ui/:path` |
| workflow | `createWorkflowHooksAppRoutes()` | `workflow.app-hooks` | `POST /hooks/:publicHash` |

`main.ts` 的 7 条 `.use(...)` 收成一条 `.use([...takeRouteContributions(APP_SLOT)])` 放在链尾；相应 import 与
只服务于它们的 `authenticateSiteRequest`、`authGuardPlugin`、`authenticateRequest` 宿主导入一并删除
（后两者仍由 `bootstrap/route-host.ts` 持有，`main.ts` 不再直接消费）。`route-contributions.test.ts` 的真实
profile 断言新增 `APP_SLOT` 分组（13 条路径），并新增一条 `order` 用例、把「未声明 slot 拒绝装配」改成
「未声明 slot 落在 `app` 槽」。

两处模块级单例（`knowledgeMcpRoutes`、`skillDownloadRoutes`）的装配函数只包一层惰性构造函数、不复制第二份
实例——它们不是工厂（自鉴权、无守卫可注入），贡献的 `value` 却必须是函数，包一层是最小改动。两处都在包内
注释里写明了理由。

**二、【需审核】宿主 `authenticateSiteRequest` 删除、投影移入包内**

上一片起，站点代理的请求级认证曾是宿主 `plugins/auth.ts` 的一个导出（`AuthenticateSiteRequest` 类型的实现，
投影出 `{userId, organizationId}`）。本片把它删掉，改由 `agent-config` 的 `assembly.ts` 的 `siteAuthenticator(host)`
在包内做同一份投影。

理由是职责归属：`ServerRouteHost` 已经有 `authenticateRequest` 端口，站点代理要的只是它的一个投影，而投影规则
（「可见性判定只认 userId / organizationId」）属于包自己的依赖契约——留在宿主等于让宿主的 `plugins/auth.ts`
替包决定包需要什么。删除后 `ServerRouteHost` **仍然是 10 个端口**（没有新增，也没有减少），包侧不 import 宿主
的 `AuthContext`：投影只按结构化类型读 `authContext` 上的两个字段。

代价是这份投影从「宿主唯一实现」变成「包内实现 + 宿主端口实现」，`authenticateRequest` 本身仍是唯一认证源。
若不认可这个归属，替代方案是把投影作为一个新的宿主端口加进 `ServerRouteHost`（第 11 项），但那样会把
1.5f-1a §二已经点出的「接口正在承载宿主能力之外的东西」再推一步。

**三、【需审核】`app` 槽内的挂载顺序与手写序不同**

槽内顺序 = 拓扑序 + manifest 内声明序（+ `order` 稳定排序），实际登记序见上表的行序：`acp` → `mcp` →
`skill` → 站点代理 → `workflow-ui` → `hooks` → 站点兜底。与迁移前 `main.ts` 的手写序相比，前三项从
`createApiApp` 之后前移到 `createWebApp` 之后（`skillDownloadRoutes` 与站点代理同理后移），其余相对位置不变。

逐前缀核对无遮蔽：`/acp`、`/mcp/knowledge`、`/skills`、`/web/site/deploy`、`/workflow-ui`、
`/hooks/:publicHash`、`/*` 七个前缀互不重叠，且唯一的通配 `/*` 排在最末。Elysia 的 radix 匹配对静态段优先于
参数段，因此顺序不参与正确性判断——顺序唯一有语义的地方是通配兜底，而它现在由贡献自己声明。

**四、【需审核】首例 `order` 使用，与 `route-faces.ts` 的有意留白**

本片是 `ModuleContribution.order` 的**第一个使用者**（此前 grep 无命中）。契约与实现早已就位
（`module-manifest.ts:24-44` 的文档 + `bootstrap.ts:101-106` 的 `orderContributions()` 稳定排序），本片只是
第一次真的需要它：`/*` 兜底必须最后挂，而它在 manifest 里的声明序位于站点代理之后、`workflow` 之前
（拓扑序第 8），不写 `order` 就会排在 `/hooks/:publicHash` 前面（虽然 radix 下仍不改变匹配结果，但「兜底不是
最后一个注册」这件事本身不可接受）。

取值 `100` 没有语义刻度，只是「比默认 0 大」的标记；风险是将来若有第二个贡献也写 `order`，两者的大小关系
并不表达任何跨模块的优先级约定。**记录在案，不在本片处理**：如果出现第二个使用者，值得把 `order` 的语义
收窄成命名常量（如平台层导出 `FALLBACK_ORDER`）。

`test-utils/route-faces.ts` 本片**不镜像** `app` 槽（有意留白，已在文件头写明）：这一面的 7 条入口各自带独立
前缀与认证口径，包内用例已在包内测试里覆盖，宿主侧没有需要「真实路由面」的用例；多一份无人消费的镜像只会
多一处需要同步的漂移源。真实装配的镜像仍由 `route-contributions.test.ts` 的 `toEqual` 全量断言承担。

**五、手工启动验证（判据里的「服务可启动」）**

按 1.5e-3 的口径复跑：一次性 `postgres:16-alpine` 容器映射 **55432**（不复用 5432 上另一个检出的开发库），
`db:migrate` 全链应用成功后启动主进程。日志**无装配期错误**（无「未知聚合槽」「没有返回 Elysia 实例」「基础模块
未返回实例」），唯一 WARN 是 RagFlow 不可达（验证环境无 RagFlow，既有行为）。

第一轮（无 agent-sites 配置）：

| 探测 | 结果 | 说明 |
|---|---|---|
| `GET /acp/agents` | 401 `Not authenticated` | 会话守卫的 `sessionAuth` 宏在 app 槽数组内解析成功 |
| `GET /workflow-ui/` | 401 同上 | 同上 |
| `POST /mcp/knowledge` | 400 `authorization: expected string` | 自带的 Bearer schema 校验已执行 |
| `GET /skills/nope/download?token=bogus` | 403 `Invalid skill download token` | 令牌校验已执行 |
| `POST /hooks/deadbeef` | **404** `{"error":"trigger not found"}` | 路由自己产生的 404（SPA 兜底不会返回它） |
| `GET /api/skills/`、`GET /web/prod-views/anything/load` | 全 401 | 先注册的两面未被 app 槽的通配兜底遮蔽 |
| `GET /api/system/logs/` | 401 `Invalid system API key` | system API 面仍在 |
| `GET /health` | 200 | 服务存活 |
| `GET /nope`、`GET /web/site/deploy/app-abc123` | 均 200 | 对照项：未注册路径走 SPA 兜底。**站点链路未配置时代理直接让路**，与兜底同为 200，无区分度——故补第二轮 |

第二轮（`AGENT_SITES_BASE_URL` 指向不可达地址 + 一次性 dummy `AGENT_SITES_MASTER_KEY`，并在验证库里临时插入
一条 `visibility = 'public'` 的 `agent_site_app` 行 `app-verify0`）：

| 探测 | 结果 | 说明 |
|---|---|---|
| `GET /web/site/deploy/app-verify0/` | 502 `bad_gateway: Agent Sites unreachable` | 站点代理路由已注册，且处理函数真的跑到了转发 |
| `GET /app-verify0/api/x` | 502 同上 | **`/*` 兜底已注册且未被遮蔽**——本片风险最高的一条 |
| `GET /app-nosuch99/x` | 200 | 兜底解析到库内不存在的 appId 后让路（`parseAppPath` 命中但 `getAppByRemoteId` 为空） |

验证容器、服务进程与那条临时数据都在收尾时删除/停止；未保留可复用库。

第二轮同时关掉 §六第一条风险：「通配符路由（`/app-xxx/*` 兜底、`/web/site/deploy/:appId/*` 代理）的相对优先级需
在 1.5e 试点与 1.5f 切换后实测确认」——现在两条都在贡献面下实测到真实处理结果（502），切到拓扑序 + `order`
之后优先级没有变化。

**六、本片收尾状态：`main.ts` 里已无协议路由 import**

`grep -n 'from "@fenix/' apps/server/src/main.ts` 现余 13 处，**全部是生命周期/启动编排符号**（`1.5f-1c` 的范围）：
`@fenix/agent-config/server`（`getAgentConfigModule` / `setMetaAgentModelResolver`）、`@fenix/agent-runtime/runtime`
（`createAgentRuntimeModule`）、`@fenix/agent-runtime/server`（`bind*Port` 系列、事件总线、workspace 解析）、
`@fenix/identity/server`（`createIdentityDirectory` / `ensureSystemAdmin`）、`@fenix/model-management/server`、
`@fenix/resource-channel/server`、`@fenix/resource-knowledge/server`（`checkRagFlowHealth`）、
`@fenix/resource-machine/server`、`@fenix/resource-sandbox/server`、`@fenix/resource-task/server`（`schedulerService`）、
`@fenix/resource-workflow/server`（`initCustomToolsRegistry`），外加按裁定保留的 `@fenix/logger` 与
`@fenix/platform-sdk/server`。`main.ts` 现 572 行，包路由的挂载点只剩 4 条 `.use()`（`authPlugin` 之外的三面聚合
+ 一条 `app` 槽）。
