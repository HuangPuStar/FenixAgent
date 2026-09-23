# 后端开发规范

本文档面向 FenixAgent 后端开发，约束模块归属、依赖方向、分层职责、授权与租户隔离、模块装配、数据库与迁移、API 设计、日志、注释和文档同步。

规范依据与冲突口径：与[目标架构与开发规范](../../design/ce-ee-refactoring/ce-ee-engineering-standards.md)冲突时，以该文档为准；其余规则以离代码更近、约束更具体者为准。

| 文档 | 说明 |
| --- | --- |
| [目标架构与开发规范](../../design/ce-ee-refactoring/ce-ee-engineering-standards.md) | 长期架构目标与最终一致性验收的权威依据 |
| [目录结构与归属说明](../../design/ce-ee-refactoring/ce-ee-engineering-directory-structure.md) | 目录与文件的物理 owner |
| [用户、组织与资源权限模型](../../design/ce-ee-refactoring/ce-access-control-design.md) | 授权接口与迁移边界 |
| `CLAUDE.md`、本文件 | 项目特有的落地细则 |

> 本文是后端开发的规范条文，约束新增与重构的代码，**不以仓库现状为准**：现存代码中不符合本文的地方属整改项，
> 与本规范无关。新增或重写代码时直接按本文实现；**内部实现路径**不新增兼容层、deprecated shim 或双写逻辑，应直接删除过时实现。
> 已发布的对外协议与已应用的数据库迁移仍按其契约、迁移和验证要求处理。

## 1. 架构总览与依赖方向

### 1.1 三条长期边界

```text
资源动作请求
  → Resource Facade：身份/授权、资源状态、业务编排
  → Runtime Port：已解析的通用启动参数
  → Runtime：实例、引擎、连接、停止、回收
```

- **Runtime**（`@fenix/agent-runtime`）不读取 actor、role、scope、资源发布状态，也不查询资源表；只接收已授权的通用启动输入。`AgentInstance` 是运行时产物，不是可授权资源。
- **Resource** 不直接了解引擎进程、实例租约或 relay 实现；`AgentConfig` 的 `use` 权限由资源层决定。
- **Platform**（`packages/platform/*`）持有身份、租户与授权语义，不承载资源领域逻辑；资源只依赖授权契约，不依赖具体授权实现。

### 1.2 包类别依赖矩阵

`apps` 是唯一的组合根，依赖方向由上层组合流向稳定契约。下表是权威矩阵的摘要，完整口径与准入规则见规范 §2.3。

| 包类别 | 可以依赖 | 禁止依赖 |
| --- | --- | --- |
| `platform/platform-sdk` | 语言标准库与无业务语义的基础依赖 | 具体平台实现、`agent-runtime`、`resources`、`apps` |
| `platform/identity` | `platform-sdk` | `access-control`、`agent-runtime`、`resources`、`apps` |
| `platform/access-control` | `platform-sdk`、同版本的 `@fenix/identity` 公开入口 | `agent-runtime`、`resources`、`apps`、identity 内部路径 |
| `agent-runtime` | `platform-sdk`、`sandbox`/`machine` 的专用公开运行入口 | 其余 `resources`、具体 AccessControl/Identity、`apps` |
| `resources/machine` | `platform-sdk`、本资源声明的基础依赖 | `agent-runtime`、`sandbox`、具体 AccessControl/Identity、`apps` |
| `resources/sandbox` | `platform-sdk`、`machine` 公开入口、Sandbox Provider 公开 API | `agent-runtime`、具体 AccessControl/Identity、`apps` |
| 其余 `resources/<resource>` | `platform-sdk`、其他资源包根入口公开的 service/DTO | `apps`、具体 AccessControl/Identity、其他资源的 `src/**`、repository/schema |
| `resources/<resource>/web` | 本资源与其他资源 `./web` 公开的 DTO/client/hook/组件 | 所有服务端 `services`/`repositories`/db/adapter、`apps/web` 内部 |
| `apps/server` | 所有已启用包的公开入口 | 任意包内部路径 |
| `apps/web` | `resources/*/web` 公开入口、版本自己的 Shell | 服务端实现与 server-only 导出 |

- 反向于默认层级的直接依赖只有经评审登记的边：`access-control → identity`、`agent-runtime → sandbox`、`agent-runtime → machine`、`sandbox → machine`。禁止通配规则（如 `agent-runtime → resources/*`）。
- CE 代码不依赖 `@fenix-ee/*`；CE 与 EE 的替换实现只在同一套公开契约下各自演进。
- `Machine`/`Sandbox` 不得回调 Runtime 的 repository、singleton 或生命周期实现。
- 依赖必须无环。出现环时把共同概念抽到 `platform-sdk` 稳定契约，或把协调流程上移到 `apps/server`，不得靠互相 import 解决。
- 上述方向、循环依赖与跨包穿透由 `bun run check:dependencies`（dependency-cruiser）和 `bun run architecture:check` 强制，二者均已纳入 `bun run precheck`；违反时输出源文件、目标文件与规则名。

### 1.3 跨包引用与依赖声明

- 跨包只使用包名与 `package.json#exports` 公开的入口（`.`、`./db`、`./module`、`./server`、`./web`、`./server/runtime` 等）；禁止相对导入任何 `packages/**/src/**`，相对导入仅限同包内部。
- 每个包必须显式声明自己用到的 workspace 依赖，不得依赖根 workspace 的偶然提升；`apps/*` 同样适用。仅构建/测试使用的声明在 `devDependencies`。
- 声明与真实导入必须一致：`dependencies` 中没有导入的条目要删除，删除前逐条 grep 全包确认。
- 资源的 `web/` 交付物中，**实际导入**的框架库（`react`、`react-dom`、`react-i18next`、`i18next`、`@tanstack/react-router`）声明为 `peerDependencies`，版本范围与根 `package.json` 一致（写进 `dependencies` 会打进第二份实例，导致 context/命名空间静默失效）；可独立打包的普通库声明为 `dependencies`；仅测试导入的声明为 `devDependencies`。

### 1.4 静态插件点

Agent 引擎、RAG、MCP、Sandbox、部署目标等天然多实现能力，只做**静态插件点**：稳定抽象定义在上层（`platform-sdk` 或资源包根入口），具体实现落在独立包或资源内的 Provider，由配置选择实现。

- 接入原则：可插拔、可替换、独立演进、低耦合、配置驱动。
- 步骤固定：上层定义抽象接口与 schema → service 只面向抽象编程 → service 内按配置选择实现（本地 / 远程 / 测试桩）→ 具体实现封装在独立包，负责 SDK 封装、协议适配、错误转换与独立测试。
- 主服务与资源 service 只依赖抽象，不散落 `if provider === "xxx"` 分支，也不直接堆第三方 SDK 调用。
- 第三方能力需要暴露页面时，优先由 route 做代理或转发边界，不把第三方页面逻辑散落到业务代码里。
- 仅当第二个真实用例出现后才抽象额外 SDK；单一场景直接实现。
- 不把资源、权限和控制台整体做成动态插件，也不实现运行时扫描、下载或热加载业务模块。

### 1.5 资源模块之间的关系

资源模块默认独立，是否建立依赖由**领域关系**决定，不由目录相邻或实现便利决定；依赖必须单向且无环。三类关系必须选最轻的一种：

| 场景 | 允许的实现 | 禁止的实现 |
| --- | --- | --- |
| 仅保存关联 | 存对方的稳定 `resourceId`，必要时维护自己的引用索引或快照（如 `agentConfig.skillIds`） | 以 name 作关联；导入对方的表或 repository |
| 写入、发布或运行前校验对方 | 依赖对方**包根入口公开的 Domain Service**，其公开方法即稳定调用契约（如 `SkillService.getByIds()`） | 导入对方 `src/services`、repository，或自行复制对方的状态判断 |
| 跨资源协调 | 由拥有该动作的资源 Facade 编排多个公开 port；流程无明确资源归属或涉及删除、批量同步、跨资源事务时上移到 `apps/server` 的 use case | 任一资源 route 调用另一资源 route；在 repository 中调用 service |

- 关系紧密且长期稳定时，不为形式统一额外创建接口。只有同一能力存在多实现、调用方只需极小能力、或直接依赖会产生环时，才在包根入口导出最小公开接口，并由 `apps/server` 装配注入具体实现。
- 前端遵循同样的宽松规则：可直接依赖另一资源 `./web` 公开的 API client、hook、DTO 或组件，禁止导入对方 `web/src/**` 内部文件；前端仅用于展示与选择，后端保存关联时必须再次校验引用资源的当前权限与有效性。

## 2. 目录与模块归属

### 2.1 宿主 `apps/server`

宿主只保留进程入口、协议聚合、认证 adapter、OpenAPI、通用横切和装配边界，不枚举业务模块、不承载领域规则：

```text
apps/server/src/
├── main.ts / bootstrap.ts     # 进程入口与装配
├── bootstrap/                 # assembly 解析、路由槽装配、启动序列、宿主端口注入
├── routes/                    # 协议聚合器：web/、api/（业务路由由模块贡献）
├── plugins/                   # auth、cors、error-handler、logger、static、system-api-auth
├── db/                        # 连接与宿主 schema（见 §6.2）
├── errors/                    # 领域错误 → HTTP 响应的映射；跨层错误定义在 errors.ts，这里不作通用 barrel
├── openapi.ts                 # 两套文档的统一装配入口
├── env.ts                     # 宿主自有与多模块共享环境变量（见 §5.3）
└── services/                  # 仅宿主编排与横切（装配辅助、数据迁移注册表）
```

### 2.2 资源模块 `packages/resources/<resource>`

资源模块是一组同生命周期的交付物，不是裸 service：

```text
packages/resources/<resource>/
├── src/
│   ├── module.ts              # 模块工厂，产出可装配实例
│   ├── server.ts / index.ts   # 包出口（后端能力）
│   ├── server/
│   │   ├── access/            # 资源声明：ResourceDefinition + 列绑定
│   │   ├── facades/           # Resource Facade（唯一带 actor 的入口）
│   │   ├── services/          # Domain Service（无 actor）
│   │   ├── repositories/      # 持久化与事务原语
│   │   ├── schemas/           # 请求/响应校验 schema
│   │   ├── routes/            # 本资源协议路由（web/、api/、协议专用）
│   │   ├── ports/ adapters/   # 跨模块端口与外部适配（按需）
│   │   └── config.ts          # 本模块配置读取封装
│   └── __tests__/
├── db/schema.ts               # 本模块表定义的唯一 owner
├── web/                       # 页面、API client、hooks、i18n、contribution
├── fenix.module.ts            # 模块 manifest（见 §5.1）
└── README.md
```

- 只创建有真实用例的目录与抽象；不因模板而生成空目录、空 Facade 或空 migration。
- `web/` 与 `src/` 物理就近，通过 subpath export 隔离：**根入口只导出后端能力**，浏览器能力经 `./web` 导出。从根入口 re-export 服务端模块会把 Node 依赖打进浏览器 bundle。
- 同一个表或同一类资源的业务操作内聚在本模块，不复制到别包，也不按 SQL 动作拆散。
- 资源模块**不得新增或扩展 `/api/*` 外部 API**；已发布的 `/api` 路由是薄协议 adapter，变更需独立 ADR 与消费者盘点。

### 2.3 平台模块与 Runtime

- `packages/platform/platform-sdk`：只有稳定契约（资源范围、授权端口、身份目录投影、模块 manifest、应用基础设施访问入口），无 DB、无 route、无 Web。
- `packages/platform/identity`：用户、组织、成员、认证/API Key 及其 DB、route、Web；产出可信身份上下文。
- `packages/platform/access-control`：默认授权实现，可依赖 identity 公开入口，不得导入其 repository/schema/内部路径。
- `packages/agent-runtime`：组合 Environment、Instance、生命周期、并发与 relay/session；不解释 actor 与权限。
- `packages/*` 适合放运行时插件、协议适配器、SDK、可替换执行引擎与独立封装的服务接入层；主服务只依赖其导出的稳定接口，不耦合内部实现细节。
- `packages/` 下其余包为独立 SDK/插件包（`acp-link`、`core`、`orchestration`、`chat-channel` 等），服务模块经包引用直接使用，只要求包间依赖无环。

### 2.4 仓库级目录

| 目录 | 职责 |
| --- | --- |
| `drizzle/` | 不可变 DDL 链与 `meta/`（snapshot、journal），必须整体提交 |
| `db/` | 仓库级迁移执行器 `data-migration-runner.ts`，不含业务迁移逻辑 |
| `deploy/assembly/` | 装配 profile（选择已构建模块的组合） |
| `scripts/` | 开发、校验、构建、迁移、发布的薄命令入口 |
| `docs/arch/`、`docs/adr/` | 当前架构说明、关键架构决策记录 |
| `docs/operations/` | 部署、升级、迁移、备份、排障 |

## 3. 后端分层

### 3.1 依赖方向

```text
route / 外部调用
  → Resource Facade（授权、状态校验、跨资源编排、事务边界、幂等）
  → Domain Service（资源自身领域规则与数据访问，无 actor）
  → Repository（存储查询与事务原语）
  → db

Facade / Service → adapters（外部协议与 Provider 差异）
Service → 其他资源包根入口公开的 Domain Service
route → schemas
```

禁止反向依赖与跨层复用：repository 不得调用 service/route；route 不得导入另一 route 的业务逻辑；repository 不得承载业务判断。

### 3.2 Route 层

- route 只做协议接入：参数解析、schema 校验、认证上下文提取、DTO 转换、调用 Facade、映射响应与错误。
- 不直接访问 db/repository、不写跨表事务、不做文件系统落盘、不直接调用第三方 SDK、不调用其他 route。
- 不自己做业务编排；需要组合多个动作时下沉到 Facade。
- 依赖 Facade 导出的接口（`XxxFacadeApi`）而非具体实现类。
- 错误映射要稳定，对外错误码可预期，不把底层实现的错误结构直接透出。
- 路由文件按 `dependencies.ts` + `web/`（+ 可选 `api/`、协议专用目录）组织；宿主协议聚合器在 `apps/server/src/routes/`，业务路由经 manifest contribution 挂载到 `web` / `web-config` / `api` / `app` 槽。

### 3.3 Resource Facade 层

Facade 是资源对外部操作的唯一入口，命名 `*-facade.ts`、类名 `XxxFacade extends AuthorizedResourceFacade`：

- 所有公开方法首参为 `actor: ActorContext`，并完成该动作的授权：`resolveInitialScope`（创建期归属）、`listConstraint(actor, action)`（列表条件）、`authorizeAction`（单资源动作）、`withAccessMany` / `setVisibility`（批量动作与可见性）。
- 把授权失败映射为稳定的领域错误（`ResourceAccessDeniedError` → 403），不把底层授权实现的错误结构泄漏给 route。
- 承担跨资源编排与副作用（如停实例、清 Environment、重启），并决定事务边界与幂等策略。
- 只有 Facade 认识 actor。领域服务不接受 actor，也不做用户权限判断。

### 3.4 Domain Service 层

- 只处理本资源领域规则与数据访问，方法按业务语义命名，入参是资源标识与领域输入。
- 列表/详情方法可接收 Facade 产出的**不透明** `access: ResourceQueryConstraint` 并原样下推，不得解析其内部结构、不得自行构造，也不得据角色或 `visibility` 二次过滤。
- 可被受信任的资源模块经包根入口复用（如 AgentConfig Facade 校验引用后直接调用 `SkillService`）；复用不授予用户对被引用资源的独立权限。
- 领域服务不接收 `ActorContext`；以 actor 为形参属于越界，应把该判断移回 Facade。
- 不直接操作数据库连接、ORM 实例或 SQL 构造器：凡是数据库读写、查询条件拼装、事务内持久化步骤，都先收敛到 repository，再由领域服务编排调用。

### 3.5 Repository 层

- 只做持久化：查询、插入、更新、删除、分页、排序、条件拼装与事务原语。
- repository 不直接暴露给 route，只由 Domain Service 与 Facade 调用。
- 受控资源查询统一经 `AuthorizedResourceQuery` 端口下推授权条件，资源侧只声明资源类型、表与列绑定及业务条件：

```ts
// 只声明列，不解释列语义；成员/角色/visibility 的判定不在资源包内
return this.authorizedQuery.list({
  resourceType: "agent_config",
  table: agentConfigs,
  columns: { id: agentConfigs.id, organizationId: agentConfigs.organizationId,
             ownerUserId: agentConfigs.userId, visibility: agentConfigs.visibility },
  access,                                    // Facade 产出的不透明条件
  businessWhere: [eq(agentConfigs.status, input.status)],
});
```

- Repository **不得**读取 member/role 表、不得自行判断归属列或 `visibility`、不得复制授权 SQL，也不返回带业务副作用的结果。
- 禁止先读全量数据再在应用层按组织、角色或可见性过滤；过滤必须在数据库分页、排序、计数之前完成。
- 极少数确实无法合理沉淀到 repository 的复杂只读查询，可在评审后作为例外；必须在实现处注明原因、适用范围与移除条件，避免演变成绕过 repository 的先例。

### 3.6 事务、并发与故障

- 跨表写入的事务边界由发起动作的 Facade 决定；`db.transaction` 等事务原语封装在 repository 或包内 `db.ts`，不在 route 开启，也不写在纯领域规则里。
- 事务范围最小化，避免长时间持锁；外部调用（引擎、Provider、HTTP）不放在事务内，必要时先落状态再补偿。
- 写路径必须显式考虑幂等性、竞态、超时、取消、重试上限与资源释放；不得用无边界重试或吞错掩盖失败。
- 失败路径要留下可定位的诊断上下文，并对不可逆步骤给出补偿方案。

## 4. 授权与租户隔离

### 4.1 授权止于 Facade

- 外部资源动作一律由 Resource Facade 用可信 `ActorContext` 与 `AccessControlModule` 授权。
- `ActorContext` 由 identity 公开入口从 session / API Key / Environment Secret 解析后构造，`memberships` 是**全量**成员关系；授权层不反推身份。
- 授权口径：资源的归属组织必须是 actor 的**当前 active organization**；跨组织共享只由 `visibility = 'public'` 表达。不得把 `memberships` 展开成组织 ID 的 `IN` 列表。
- 全局系统管理员仍是带真实 `userId` 的 actor，由 `AccessControlModule` 放行系统级动作；迁移、运维与模块内部调用不构造 actor，直接使用受信任的 Domain Service。
- 列表条件与单资源校验必须由**同一份策略函数**派生，不允许各写一套。

### 4.2 资源声明与范围

- 可授权资源主表复用 `organization_id`、`user_id`、`visibility` 作为范围真相来源；资源包只声明「资源类型 + 表 + 归属列 + 业务条件」，语义解释由 `ResourceScopeStore` 与 `AccessControlModule` 承担。
- 新增受控资源必须在资源包声明 `ResourceRegistration`（`definition` + `storage`），并经 manifest 的 `accessControlBindings` 登记；未登记的 `resourceType` 直接报错，不静默返回空。
- 二级资源（如 Model 之于 Provider）不注册独立的 owner/visibility，按操作复用所属资源的 read/use/update/delete 权限，并在分页排序前下推其约束。

### 4.3 隔离红线

- 前端传入的 workspace/cwd、组织 ID、owner 一律不可信；组织上下文按 `x-active-org-id` header → `activeOrganizationId` query → `active_org_id` cookie 优先级提取。
- API Key 的组织上下文必须由 key metadata 恢复并**重新校验成员关系**；异常时保守拒绝。
- 文件路径必须经过词法校验（绝对路径、`..`、控制字符）与 realpath 越界检查，防 symlink 逃逸。
- 前端的可见/不可见只是体验，服务端 Facade 授权才是安全边界。

## 5. 模块装配与配置

### 5.1 `fenix.module.ts`

每个可装配包在根目录导出唯一 manifest（`satisfies ModuleManifest`），字段固定。以下仅说明字段关系；实际实现必须使用模块内已定义的 manifest 值与惰性构造函数：

```text
export const moduleManifest = {
  id: "agent-config",
  kind: "resource",                       // access-control | agent-runtime | identity | resource | web-shell
  dependsOn: ["knowledge", "mcp", "memory", "skill"],
  capabilities: ["resource.agent-config"], // 同一 capability 不得由两个已启用模块提供
  envDefinitions: [moduleEnvDefinition],
  web: { id: "agent-config", contribution: "@fenix/agent-config/web/contribution" },
  accessControlBindings: [agentConfigResource.storage],
  contributions: [lazyContribution],
  create: createAgentConfigModule,
} satisfies ModuleManifest;
```

- `kind`、`capabilities`、`dependsOn`、`web.contribution` 均由门禁静态读取：`web.contribution` 必须是字符串字面量，`create` / `contributions.value` 必须是惰性构造函数。
- `dependsOn` 是**装配依赖**（同一 profile 中须成套启用），不能取代 TypeScript 的 `package.json` dependency，也不放宽编译依赖规则。
- manifest 不手改生成物：registry 由 `bun run generate:module-registry` / `generate:web-contributions` 扫描生成，`apps/generated/` 下的文件禁止手工编辑。
- `apps/*/fenix.module.ts` 只允许 `kind: "web-shell"`，且文件内只允许 `import type`（不得出现值导入或 `export ... from`），保证它不进服务端 registry。

### 5.2 装配 profile

- `deploy/assembly/*.json` 只在**已编译进镜像的模块**中选择组合，禁止出现任意文件路径、URL、npm 包名、表达式或代码片段。
- 启动顺序：读取 profile → 校验结构与重复 ID → 对照生成 registry 校验 ID/类别 → 校验 manifest 依赖、capability 冲突、env 与 migration preflight → 创建依赖并挂载路由贡献。
- profile 只能选择生成 registry 中的可信模块；新增模块只需提供 package、manifest 和 assembly ID，不改 app 注册逻辑。

### 5.3 环境变量与模块配置

- 一个进程只有一个宿主。宿主解析 assembly、汇总已启用模块的 `envDefinitions`，统一读取并校验 `process.env`，创建进程级 DB client，再调用 `initializeApplicationInfrastructure()`；模块开始运行前必须完成这一步。
- 模块从应用基础设施读取自身已校验的只读配置，**不读 `process.env`、不加载 `.env`、不导入 `apps/server` 的 env/config/db**：

```ts
// 包内 src/server/config.ts：读取 + zod 校验 + 类型化 getter
const config = getModuleConfig<AgentRuntimeEnv>("agent-runtime");
```

- 读取只能发生在处理请求、任务或启动逻辑时，不能在文件加载期调用，否则会早于宿主初始化。
- 环境变量有两处真相来源：宿主自有与多模块共享键在 `apps/server/src/env.ts`；有唯一 owner 的部署变量在 owner 模块的 `envDefinitions`。**同名键不得两处声明**，`assertNoHostKeyOverride()` 会在启动期拒绝。
- 模块只声明真正的部署级配置（DB 连接、对象存储、模型网关、Sandbox 地址、第三方密钥）；名称、模型、Skill、发布状态等业务配置存数据库。
- 应用基础设施只放「整台 server 共用、启动时创建、关闭时释放」的东西。随请求、用户、组织、事务或资源变化的对象（service、repository、Facade、ActorContext、事务）一律不得放入，只能经参数、包公开 API 或宿主装配传递。
- 测试用 `initializeTestApplicationInfrastructure` / `overrideModuleConfig` / `resetApplicationInfrastructure` 设置独立的 DB 与配置，不修改全局 `process.env`，也不 mock `apps/server`。
- `deploy/env/*.example` 是部署模板的真相来源，只含变量名、说明与非敏感样例；真实 `.env` 永不提交，密钥来自部署平台的 secret store、K8s/Docker secret 或受控文件。

## 6. 数据库与迁移

### 6.1 表、字段与关联设计

- 新增业务表必须有稳定主标识字段；默认用 `id` 作主键名，类型按需求、可读性和可追踪性选 `uuid` 或字符串 ID。
- 表之间统一用稳定主标识关联，关联字段命名默认与被关联表主键一致。**禁止**用名称、路径、可变 code、展示名等非稳定字段表达外键语义。
- 受第三方框架约束或历史设计影响的表，与该表 owner 模块现状保持一致，不为形式统一做高风险改表。
- 核心业务表都要有时间字段，至少 `createdAt`；可更新实体通常同时有 `updatedAt`。
- 涉及组织隔离的资源必须明确 `organizationId` 或等价租户字段。
- 一对一：仅在强约束且生命周期一致时直接放外键。一对多：若“多”的一侧有独立生命周期，可直接在子表放外键。
- 多对多必须使用独立关联表，不在单字段中存数组关系。当前关系已需要属性、排序、状态或来源时，也使用独立关联表；关联表命名要清晰表达关系，如 `agentConfigSkill`、`agentKnowledgeBinding`。不因尚未确认的未来需求改变当前一对多建模。
- 枚举语义优先用 `pgEnum` 或受限字符串，不允许魔法值散落在业务代码里。
- JSON 字段只用于确实不适合完全结构化、且读写边界清晰的数据。
- 可空字段必须有明确业务含义，不为“以后可能用到”随意 nullable。
- 允许空字符串与允许 `null` 是两个不同语义，默认值必须按语义处理（见 §9.2）。

### 6.2 Schema 所有权

- **一张表的定义只在一个 owner 手里**：业务表在所属模块 `packages/**/db/schema.ts`（经该包 `exports["./db"]` 公开）；身份表在 `packages/platform/identity/db/schema.ts`；宿主 `apps/server/src/db/schema.ts` 只留身份表转出、宿主自有 `data_migrate_record` 与经裁定暂留的旧授权栈表。
- 改哪张表就到它的 owner 包改，不得在宿主或别包复制一份。
- `drizzle.config.ts` 的 `schema` 必须声明**全部** owner 路径与宿主 schema，否则 `db:generate` 会把漏声明的一族误判为已删除。
- 跨包外键只允许在 `packages/**/db/**` 的**组装期**导入对方 `db/schema.ts` 的表对象（Drizzle `.references()` 只接受列对象）。这是依赖矩阵的唯一例外：`src/**`、`web/**` 的调用期跨包读表一律违规，必须改经 owner 的公开服务端入口或宿主注入端口；该例外不构成包级依赖边，也不进 `dependsOn` 与装配顺序。

### 6.3 DDL 变更流程

1. 修改该表 owner 包的 `db/schema.ts`。
2. `bun run db:generate --name <module>-<change>` 生成迁移。
3. 审查 `drizzle/*.sql` 与 `drizzle/meta/*`（snapshot、journal）——DDL 只处理结构。
4. `bun run db:migrate` 应用并在本地验证。
5. 补齐或更新相关 Facade、service、schema、测试与文档。
6. 提交时连同整个 `drizzle/` 目录一起提交。

- 禁止手写 SQL 迁移绕过 Drizzle，禁止在生产使用 `db:push`；生产迁移入口为 `scripts/migrate.ts` 构建出的 `migrate.js`。
- 已被正式环境消费的 migration 不可改写。表定义换手不得改变 DDL，由 `bun run check:schema-ddl-drift` 强制。

### 6.4 数据迁移

DDL 迁移与数据迁移必须分离：结构变更走 `drizzle/`，存量数据的搬迁、修复、补算、回填走模块数据迁移。

- 迁移代码归**发起变更的模块**维护（`packages/**/db/data-migrations/`）；跨模块迁移同样归属发起变更的模块，并显式声明依赖。根 `db/data-migration-runner.ts` 只做汇总、排序、记录与失败停止，不放业务逻辑。
- 每个迁移实现 runner 的统一接口并注册到模块导出的 migration manifest，ID 全局唯一，执行记录写入 `data_migrate_record`。
- ID 格式 `<模块>/<YYYYMMDD>-<名字>`（日期取首次进入仓库的日期）。ID 一旦落入 `data_migrate_record` 即成为发布契约：**已应用的迁移不改名**，改名会被判为未应用而重跑；该格式只约束新增迁移。
- 迁移逻辑必须幂等，失败后重新执行可安全重试；禁止把批量 `UPDATE/INSERT/DELETE` 修复逻辑直接写进 DDL SQL。
- 每个迁移必须声明 `dependsOn`、幂等可重试的 `run(context)`、结果校验 `verify(context)`、失败补偿 `compensation`，并记录预期数据量、锁风险与可观测字段。
- 迁移使用受限的 repository/SQL adapter，**不得调用运行中的 service**——其当前业务行为可能已不兼容历史数据。
- 发布顺序固定为：DDL 迁移（`migrate.js`）→ 数据迁移（`bun run run-data-migrations`）→ 部署新版本进程。顺序颠倒会因缺列/缺表而失败。
- 数据迁移由部署发布任务执行一次，**不在应用进程启动时运行**，也不写进容器启动命令（多副本会重复执行带文件副作用的迁移）。
- 执行进程必须与应用**同一份环境变量与数据卷**：路径/卷不一致会留下「记录已落库、应用读不到迁移后文件」且重跑被跳过的不可自愈状态。

### 6.5 冲突与故障处理

- 一个功能分支若生成多个迁移节点，合并前压缩为一个新增节点。
- 本地链与远端冲突时，先同步远端迁移，再基于最新 schema 重新生成；不要手工拼接 SQL 凑过冲突。
- 迁移失败时先确认数据库落点、`drizzle/meta/_journal.json` 与本地 schema 是否一致，再决定回滚或重生。
- 涉及生产问题时先定位数据库结构、迁移记录与代码 schema 的差异，再选择修正迁移文件、修正记录或人工对齐。更细规则以 `drizzle/README.md` 为准。

## 7. API 设计

### 7.1 前缀与消费者

| 前缀 | 消费者 | 约束 |
| --- | --- | --- |
| `/web/*` | 控制台前端与可同步升级的第一方调用方 | 第一方控制面，可随 server/web 同步升级，不作为公开合同 |
| `/api/*` | 外部程序、SDK、OpenAI-compatible 客户端 | 已发布的稳定协议面，只做认证、DTO 与错误映射 |
| `/acp/*`、`/mcp/*`、`/hooks/*`、WS/SSE | 协议桥接 | 独立协议契约，不作为第二套资源业务 API |

- 设计、命名、鉴权与兼容性判断前，先明确接口属于哪一类。`/web` 允许更贴近页面交互与控制面板场景，`/api` 的返回结构不随前端页面实现细节摆动。
- `/api` 与 `/web` 必须调用**同一个** Resource Facade，不得存在第二套业务实现。
- 内部协议路由不放进 `web/`、`api/` 目录，使用独立前缀；默认 `detail.hide: true`，仅在确有文档消费方时公开。

### 7.2 设计规则

- API 功能单一明确。不通过 `action` 字段在一个接口里分支多种业务行为；只有明确要求或天然多消息类型（WebSocket、事件流）才允许。
- `/web` 返回 `{ success: true, data }` 或 `{ success: false, error }`；无业务数据时也返回 `{ success: true, data: ... }`，避免同类接口结构不一致。配置聚合型 `action` 接口保持既有风格，新增接口不默认沿用。
- `/api` 不跟随 `/web` 使用 envelope，保持「成功返回裸对象或列表对象、失败返回 `{ error }`」，避免内部控制台规范误伤对外兼容性；列表返回 `{ items, total, page, pageSize }` 而非裸数组。
- 错误响应统一返回含 `code` 与 `message` 的 `error` 对象，不返回裸字符串或结构不固定的对象。

### 7.3 路由设计

- URL 使用小写 kebab-case，资源名优先复数，如 `/web/knowledge-bases`。
- URL 表达资源，动作用 HTTP 方法表达；非 CRUD 动作用动作后缀，如 `POST /web/agent-configs/:id/publish`，且始终经资源 Facade 进入服务层与 port。
- 路径参数只放资源标识与层级（`:id`、`:sessionId`）；筛选、分页、排序、开关放 query。
- 分页统一 `page` / `pageSize`，排序统一 `sortBy` / `sortOrder`，布尔筛选使用语义化命名（`includeDisabled`、`withMembers`）。
- `GET` 只查询、不带 body；创建与触发动作 `POST`，更新 `PUT`，删除 `DELETE`。

### 7.4 Elysia + OpenAPI 标准写法

- 每个 route 文件同时包含：参数/请求体/响应 schema 绑定、鉴权声明、OpenAPI 元数据、调用 Facade 的实现。
- route 上补 `detail`，并显式声明 `params`、`query`、`headers`、`body`、`response`，使用 schema 目录导出的实体，不补 `any`；`summary`、`description` 与 tag 描述统一中文。
- 字符串 `model` 引用只用于历史兼容或少量共享注册场景；新接口默认使用 schema 实体。
- schema 必须定义在 `apps/server/src/schemas/` 或资源包 `src/server/schemas/`，禁止在 route 中内联声明字段结构。
- 已声明 `response` 且存在非 2xx 分支时，默认用 `status(code, body)` 返回而非 `error(code, body)`；使用 `status` 时不得改变既有响应结构，前端已依赖的历史错误 body 必须保持兼容。
- 为 OpenAPI 展示补充必要的 `model` 注册；全局 tag、文档分组、tag 描述与挂载路径统一维护在 `apps/server/src/openapi.ts`，供 `/api` 与 `/web` 两套文档分别挂载，不散落到各 route 或 `main.ts`。
- 内部使用、框架透传、静态资源、代理、MCP、WebSocket 等不面向外部开发者的能力也要补说明，需要隐藏时用 `detail.hide: true`。

### 7.5 变更兼容性

- 默认向后兼容，新增字段采用「追加不破坏」。
- 删除字段、修改字段语义或默认值、改变错误结构均属破坏性变更；无法兼容时新增接口或版本，不直接改坏旧接口。
- `/web` 即使内部使用也要考虑现有前端调用，避免静默破坏。
- 接口变更必须同步 route schema、调用方、测试与相关文档或 OpenAPI 说明。
- 前端类型必须对应后端真实返回，禁止增加「幻影字段」；协议 DTO、领域对象、数据库记录与前端 ViewModel 在边界处独立转换。

## 8. 日志与错误

- 统一使用 `@fenix/logger`：`const logger = createLogger("<scope>")`。它输出结构化日志，并通过 `requestAls` 自动注入 `requestId`、用户与组织上下文，不在每层重复记录同一错误。
- HTTP 请求由 `apps/server/src/plugins/logger.ts` 在入口生成 `requestId` 并写入 ALS，经 `X-Request-Id` 返回调用方；异步任务、实例、队列与 relay 若由请求触发，必须在显式输入与诊断日志中保留触发方 `requestId`，独立调度入口自建关联 ID。
- 不新增 `platform/observability`、`Logger`、`AuditRecorder`、`Metrics`、`Tracer` 等抽象：审计、指标与分布式 tracing 不是当前平台能力，有真实需求时另立设计。
- 业务流程、状态转换、外部调用失败、进入兜底、兼容性分支、重试、降级、跳过与提前返回都要有日志，优先记录关键上下文、分支原因、对象标识、结果状态与影响范围，避免空泛文本。临时兼容或降级路径的日志还要写明触发原因与影响范围。
- 控制台系统日志页只读取**经过权限过滤的日志投影**，不得直接枚举、读取或下载底层日志文件。
- `catch` 必须保留诊断上下文（至少记录错误对象），不得吞错；对外错误不得泄漏敏感信息或内部实现。
- 日志、错误响应、测试 fixture 与诊断包中不得出现 token、Cookie、密码、连接串；子进程与 Provider 只接收按模块显式构造的环境白名单，不透传整个 `process.env`。

## 9. 注释与文档同步

### 9.1 注释

- 类、公共函数、导出工具与类型定义必须有简洁的文档注释；职责不直观、边界条件多或被多处复用的内部辅助函数也应补充。
- 优先解释「为什么这样做」，少解释「这行代码做了什么」。非直观业务规则、兼容处理、临时方案要写原因。
- 长函数的关键处理阶段用简短注释分段；容易误用的边界条件、幂等要求、顺序要求必须注明；数据迁移、协议兼容、权限判断与降级分支要说明触发原因与风险。
- 临时方案必须写清适用范围、影响范围、风险、移除条件与可追踪任务。禁止留下缺少上下文的 `TODO`；技术债务关联可追踪任务，关键架构决策同步到 ADR。

### 9.2 代码约定

- TypeScript 业务代码禁止 `as any`；确因第三方类型缺陷需规避时，使用最小范围类型收窄或带原因的行级 ignore。
- Zod 使用 `zod/v4`。
- 允许空字符串的默认值使用 `??`，不得使用会吞掉空字符串的 `||`。
- 文件 kebab-case，组件 PascalCase，函数 camelCase，常量 UPPER_SNAKE_CASE。
- 单个文件不超过 500 行，接近上限时优先重构模块边界。
- 常规业务代码默认**按类组织**同一职责范围内的能力，不在单个文件里堆积一组松散函数；采用类作为主要组织边界时尽量减少对外暴露的零散导出，便于后续重构与替换实现。
- 纯函数工具文件、纯常量文件、纯类型定义文件不强行套类，可继续直接导出函数或常量。

### 9.3 文档同步

新增核心模块、修改主链路、调整分层职责、变更领域模型/资源关系/权限边界、引入可插拔运行时或外部服务、重构数据库模型与启动流程时，必须同步更新文档：

- 长期架构说明放 `docs/arch/`；关键架构决策放 `docs/adr/`；功能级设计与验收放 `docs/design/` 对应专题。
- 变更影响多个模块时，至少检查 `docs/arch/` 下对应专题是否需要同步，如路由、数据库、配置、实例、权限、知识库、工作流等。
- 文档要覆盖真实主流程、关键边界、依赖关系与限制条件，不能只写结论。
- 代码合入前文档必须同步；实现偏离旧文档时优先改文档，不允许文档长期失真。

### 9.4 测试

- 后端测试位于 `apps/server/src/__tests__/` 与各包 `src/__tests__/`，前端测试位于 `apps/web/src/__tests__/` 与资源包 `web/__tests__/`。
- 优先复用 `apps/server/src/test-utils/` 与包内 testing 入口；测试文件禁止直接调用 `mock.module()`。
- 每个 `test(...)` 上方添加一行中文注释，说明行为与业务意图。
- 并发、重连、权限、租户隔离、迁移与失败回滚必须覆盖关键边界；前端只测关键交互、状态与数据流，不做纯 UI 结构断言。
- 使用 `setTestAuth()` / `setTestOrgContext()` 注入上下文时，测试结束必须 reset，避免状态泄漏。

## 10. 落地清单与自动化门禁

提交前自检：

- route 只调用 Facade，没有直接碰 repository / db，也没有跨 route 复用业务逻辑。
- 新动作是否已由 Facade 完成授权，领域服务是否已脱离 actor；该领域的核心业务逻辑是否收敛在对应 Facade / Domain Service，而不是散落在 route 或工具类里。
- 列表路径是否把授权约束下推到数据库，而非读出全量再内存过滤。
- 受控资源是否已登记 `ResourceRegistration` 与 `accessControlBindings`。
- 是否新增了矩阵外的跨包依赖；跨包引用是否都走公开 export 并已显式声明。
- schema 变更是否在 owner 包内完成，并连同 `drizzle/` 完整产物提交。
- 数据修复是否走了数据迁移且幂等可重试，而非写进 DDL。
- 模块配置是否经 `getModuleConfig()` 读取，是否误读了 `process.env`。
- `/web` 与 `/api` 是否按用途分层且复用同一 Facade。
- 新接入的外部能力是否做到抽象、可替换、低耦合，并由配置驱动选择实现。
- 新表与新字段是否满足 §6.1 的主标识、时间字段、租户字段与枚举约束。
- 注释、日志、测试、i18n 与架构文档是否同步更新。

自动化门禁（`bun run precheck`，即 `scripts/ci.ts`）按序执行：format、import-sort、module-registry、web-contributions、owner-inventory、schema-ddl-drift、architecture、tsc（server / web / app skeletons / packages）、dependency-boundaries、lint、server-and-script-tests、package-tests、web-app-tests。

- `architecture` 阶段（`bun run architecture:check`）阻断可通过静态语法可靠判断的违规：反向依赖、跨包穿透 `src/**`、`zod` 非 `v4` 导入等。
- `dependency-boundaries` 阶段（`bun run check:dependencies`）依据 §1.2 矩阵与例外台账 `scripts/architecture/exceptions.json`，只阻断**未登记**的新增违规，并在某条不再违规时要求删除条目；违反时输出源文件、目标文件与规则名。禁止通配登记或长期基线豁免。
- 新增自动化规则前必须确认仓库无历史违规，并补齐「违规失败、合法边界通过」的 CLI 行为测试。
- 按变更类型追加验证：前端改动运行 `bun run build:web`；文档站点改动运行 `bun run docs:build`；数据库改动运行 `bun run db:migrate`。
- 提交信息使用 Angular 风格（`feat:` / `fix:` / `refactor:` / `test:` / `chore:` / `docs:`），标题使用中文。未经明确要求不创建 commit；不得新增 typecheck、lint 或测试错误，warning 也必须清零（info 除外）。
