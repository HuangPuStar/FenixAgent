# CE / EE 工程架构与开发规范（待评审）

> 状态：设计草案。本文只定义目标目录、边界、装配和开发规则；不冻结具体业务功能的拆分顺序。
>
> 基线：以 `AgentConfig → use 授权 → InstanceManager → AgentRuntime` 作为最小可运行闭环，并参考 2026-09-03 的 `FUNCTIONAL_MODULE_INVENTORY.md` 覆盖现有工程切面。

## 1. 目标与基本决策

目标是在两个仓库中以较小团队成本交付商业版，并允许后续为多个甲方静态定制：

1. CE 不含 EE 或甲方业务代码；EE 用 Git submodule 固定引用 CE。
2. 身份、租户和授权允许整套替换，不继承 CE 角色模型。
3. 资源基础 CRUD 尽量复用；发布、审批、客户字段和流程由 EE/甲方模块扩展。
4. Agent 引擎、RAG、MCP、Sandbox、部署目标等天然多实现能力使用静态插件点；当前不把资源、权限和控制台整体做成动态插件。
5. **当前阶段**每个模块以 manifest 自描述；构建期扫描可信 workspace（EE 还扫描固定 CE submodule）并生成静态 registry。应用在启动/部署时读取 assembly 配置，选择 registry 中已注册的模块组合，不实现运行时扫描、下载或热加载业务模块。未来若成本、隔离、签名校验、生命周期管理和运维能力成熟，可另行评审并引入动态插件；该决定不应被本文永久锁死。

### 1.1 不采用纯插件架构

纯插件架构要求 CE、EE、甲方分别实现权限、资源配置、路由和页面插件，面对身份与资源流程大幅分叉时会形成多套平行实现。本文当前采用：**稳定 SDK 契约 + 领域模块复用 + 配置驱动的静态装配 + 局部静态插件**；这不是否定未来在独立 ADR 中引入动态插件。

### 1.2 必须长期保持的边界

```text
资源动作请求
  → Resource Application Facade：身份/授权、资源状态、业务编排
  → Runtime Port：已解析的通用启动参数
  → Runtime：实例、引擎、连接、停止、回收

Runtime 不读取 actor、role、scope、资源发布状态或资源表。
Resource 不直接了解具体引擎进程、实例租约或 relay 实现。
```

`AgentConfig` 的 `use` 权限由资源层决定；`AgentInstance` 是运行时产物，不是可授权资源。运行时可记录不透明的 `launchSourceId`/`agentId` 用于追踪和恢复，但不得以它再次查询资源或作权限判断。

## 2. 仓库与目录规范

两个仓库采用相同骨架。EE 的 `vendor/fenix-ce` 是 submodule，不是第三个共享仓库，也禁止在其中提交补丁。

```text
fenix-ce/ 或 fenix-ee/
├── apps/
│   ├── server/                         # HTTP、WebSocket、启动装配、进程生命周期
│   └── web/                            # 控制台壳、TanStack Router 最终装配
├── packages/
│   ├── platform/                       # 无业务领域依赖的平台契约与基础实现
│   │   ├── platform-sdk/               # scope、授权端口、资源端口、模块描述符
│   │   ├── community-access-control/   # CE 默认身份/组织/角色实现（仅 CE）
│   │   ├── enterprise-access-control/  # EE 整体替换实现（仅 EE）
│   │   └── observability/              # Logger、Audit、Metric、Trace 的稳定端口
│   ├── agent/                          # Agent 核心：运行、实例、聊天、会话与静态插件 SDK
│   │   ├── agent-runtime/
│   │   ├── agent-instance/
│   │   ├── agent-chat/
│   │   └── agent-engine-sdk/
│   ├── resources/                      # 完整资源领域模块（后端、DB、web contribution）
│   │   ├── agent-config/               # CE AgentConfig：src/、db/、web/
│   │   ├── enterprise-agent-config/    # EE 发布/审批：src/、db/、web/（仅 EE）
│   │   └── <resource>/
├── db/
│   ├── migrations/                      # 当前仓库拥有的 Drizzle 生成物及 meta
│   └── data-migration-runner.ts         # 仅负责汇总、排序、记录和执行模块迁移
├── deploy/
│   ├── assembly/                        # 选择已构建模块组合的 JSON/YAML profile
│   ├── compose/                         # Compose 基础编排与 profile/overlay
│   ├── images/                          # Dockerfile、镜像构建上下文
│   ├── env/                             # 无密钥的环境变量模板与字段说明
│   └── manifests/                       # Helm/Kustomize 等未来部署适配器（按需创建）
├── scripts/                             # 开发、校验、构建、迁移、发布的薄命令入口
├── docs/
│   ├── arch/                            # 当前真实架构与模块边界
│   ├── adr/                             # 不轻易改变的架构决定
│   ├── developer/                       # 开发、测试、模块创建规范
│   ├── operations/                      # 部署、升级、迁移、备份、排障
│   └── design/                          # 待评审设计，不是真相来源
└── vendor/fenix-ce/                     # 仅 EE：Git submodule
```

### 2.1 目录责任

- `packages/*/*/fenix.module.ts` 声明模块，构建脚本生成 `apps/generated/module-registry.ts`；`deploy/assembly/*` 声明本版本启用的模块 ID；`apps/*` 从生成物解析、校验并注入它们。app 只做依赖注入、路由/web contribution 注册、启动和关闭，不放领域规则、包到模块 ID 的手写映射或 SQL。
- `packages/platform` 不依赖 `agent`、`resources`、`apps`。
- `packages/resources` 可依赖 platform 的公开入口；不得依赖 agent 的内部实现。需要 Agent 运行能力时，只依赖资源包本地定义的端口。
- `packages/agent` 不依赖资源包，不包含权限和资源流程。
- `packages/resources/<resource>/web` 是资源模块的浏览器专用子路径，可依赖公开 DTO、`/app` API client 和共享 UI；不得导入该资源的 services、repositories、adapters 或 db 内部实现。
- `db/` 和 `deploy/` 是仓库级交付物，不属于任意业务模块；模块通过显式贡献接入它们。

### 2.2 模块的最小交付物

每个资源模块不是一个裸 service，而是一组同生命周期交付物：

```text
ResourceModule = domain + services + repositories/adapters + schemas
               + migration + route contribution
               + web contribution + capability declaration + tests + README
```

资源模块内部推荐固定结构。`web/` 与 `src/` 物理就近，但通过 package subpath export 和依赖规则隔离：根入口只导出后端能力，`@fenix-ce/agent-config/web` 才导出浏览器能力。

```text
packages/resources/<resource>/
├── src/
│   ├── domain/          # 按需：实体、值对象、领域校验、状态机
│   ├── services/        # Facade、命令/查询、授权、事务与跨资源编排
│   ├── repositories/    # 领域数据的查询、持久化与事务原语
│   ├── adapters/        # 按需：对象存储、外部客户端、Provider 等适配器
│   ├── routes/          # createAppRoutes 等应用 HTTP route contribution
│   ├── schemas/         # DTO、请求/响应校验与边界转换
│   ├── module.ts        # 模块描述符与 capability
│   └── index.ts         # 后端唯一公开入口
├── db/                  # 本模块 schema 导出及 migration manifest
├── web/                 # 浏览器专用子路径：页面、API client、i18n、contribution
│   └── index.ts
├── package.json         # 声明 "." 与 "./web" 两个公开入口
├── fenix.module.ts      # 模块 ID、类型、依赖与 server/web contribution 声明
└── README.md
```

一个模块只在第二个真实用例出现后再抽象额外 SDK；单一客户需求先在其 EE/客户模块内实现。

### 2.2.1 跨包引用与公开 API

跨 package 只能使用包名和 `package.json#exports` 声明的公开入口，例如 `@fenix-ce/agent-instance`、`@fenix-ce/agent-config/web`、`@fenix-ee/agent-config`。禁止跨包相对导入任何 `packages/**/src/**` 路径；相对导入仅允许在同一 package 内部使用。

每个 package 必须显式声明其 workspace dependency，避免依赖被根 workspace 的偶然提升掩盖。EE 通过 `vendor/fenix-ce` submodule 加入同一个 package-manager workspace，并从 `@fenix-ce/*` 公开入口导入；不得因为物理目录相邻而导入 `vendor/fenix-ce/packages/**/src/**`。`apps` 同样遵守该规则。

### 2.2.2 资源模块之间的依赖规则

资源模块默认独立；是否建立依赖由领域关系决定，而不是由目录相邻或实现便利决定。依赖必须保持单向：例如 `agent-config` 可以引用 `skill`、`mcp`、`model`，这些被引用资源不得反向依赖 `agent-config`。出现循环依赖时，应将共同概念抽到 `platform-sdk` 的稳定契约，或把协调流程移到应用层，不能通过相互 import 解决。

```text
skill ────────┐
mcp ──────────┼──→ agent-config ──→ 已授权的启动参数
model ────────┘                         │
                                      AgentInstanceStarter port
                                             │
apps/server 注入 AgentInstanceManager ──────┘
```

资源关系分为三类，必须选择最轻的一种：

| 场景 | 允许的实现 | 示例 | 禁止的实现 |
| --- | --- | --- | --- |
| 仅保存关联 | A 保存 B 的稳定 `resourceId`，必要时维护自己的引用索引或快照 | `agent-config.skillIds` | 以 name 作为关联；导入 B 的表或 repository |
| 写入、发布或运行前校验 B | A 直接依赖 B **包根入口公开导出的 Domain Service**；该 service 的公开方法就是稳定调用契约。只有需要替换实现、多实现或防止循环时，才在根入口导出最小公开接口 | AgentConfig 调用 `SkillService.getByIds()` | A 导入 B 的 `src/services`、repository 或自行复制 B 的状态判断 |
| 跨资源协调 | 由拥有该动作的资源 service 编排多个公开 port；若流程无明确资源归属或涉及删除、批量同步、跨资源事务，则由 `apps/server` 的 use case/orchestration 组合 | 删除 Skill 前检查引用；批量发布关联资源 | 任一资源 route 调用另一资源 route；在 repository 中调用 service |

资源关系紧密且长期稳定时，不为形式统一而额外创建接口。AgentConfig 可直接依赖 Skill、MCP、模型或知识库包根入口公开的 service：

```ts
import { McpService } from "@fenix-ce/mcp";
import { SkillService } from "@fenix-ce/skill";

export class AgentConfigService {
  constructor(
    private readonly skillService: SkillService,
    private readonly mcpService: McpService,
  ) {}

  async resolveReferences(input: { skillIds: string[]; mcpIds: string[] }) {
    // 当前 Facade 已完成 AgentConfig 自身的授权；这里复用领域服务，
    // 只检查引用资源存在、启用和版本等领域状态。
    await this.skillService.getByIds(input.skillIds);
    await this.mcpService.getByIds(input.mcpIds);
  }
}
```

这里的 `SkillService`、`McpService` 必须由各自 package 的根入口显式导出；调用方不得导入 `@fenix-ce/skill/src/services/*`、B 的 repository 或 db/schema。具体 service 在 `apps/server` 装配时创建并注入，不能由资源 A 自行构造 B 的 repository 或具体授权实现。`Domain Service` 不接受 actor、不执行用户授权；资源 A 的 Facade 已授权自身动作后，可直接复用 B 的 Domain Service。资源 A 不能读取资源 B 的角色、scope 规则或具体授权实现。

前端遵循同样的宽松规则：关系紧密且稳定时，一个资源的 `web` 子路径可直接依赖另一资源 `web` 根入口公开的 API client、query hook、DTO 或可复用组件；禁止导入对方 `web/src/**` 内部文件，也不强制额外抽象接口。前端仅用于展示和选择，后端保存关联时必须再次校验引用资源的当前权限和有效性；EE 替换资源时，静态依赖对应 EE 资源的 `web` 入口，不做运行时前端模块覆盖或发现。

只有出现以下任一条件时，才在包根入口导出最小公开接口：需要在 CE/EE/甲方版替换实现、同一能力存在多个实现、调用方只需一个极小能力且不希望稳定整个 service API、或直接依赖会产生循环。该接口只暴露调用方完成自身规则所需的数据和动作，例如：

```ts
// @fenix-ce/skill（包根入口公开导出）
export interface SkillReferenceResolver {
  resolveUsableSkills(input: {
    actorId: string;
    skillIds: readonly string[];
  }): Promise<readonly ResolvedSkill>;
}
```

调用方资源只依赖此接口；具体 `SkillService` 在 `apps/server` 装配时作为实现注入。

`agent-config` 与 Agent 运行时是特殊但常见的例子：AgentConfig 的 `use` 授权、发布状态校验和启动参数生成属于资源层；`agent-instance` 不理解 actor、权限或资源生命周期。资源层只定义 `AgentInstanceStarter` 端口，`apps/server` 注入无权限的 `AgentInstanceManager`。因此 `resources/agent-config` 不依赖 `agent-instance` 或 `agent-runtime` 的内部实现，`packages/agent` 也不反向依赖任何资源包。

### 2.2.3 包类别依赖矩阵

包之间的编译依赖必须从上层组合、具体实现流向稳定契约；`apps` 是唯一允许同时依赖各业务包的 composition root。下表中的“公开入口”均指 package `exports`，不允许穿透到另一个包的 `src/**`。

| 包类别 | 可以依赖 | 禁止依赖 | 说明 |
| --- | --- | --- | --- |
| `packages/platform/platform-sdk` | 语言标准库和无业务语义的基础依赖 | `platform` 具体实现、`agent`、`resources`、`apps`、任何 EE 包 | 最底层契约：资源范围、授权端口、装配 profile、模块 manifest 等 |
| `packages/platform/*` 具体实现 | `platform-sdk`、无业务语义基础依赖 | `agent`、`resources`、`apps`；CE 包禁止 EE 包 | 例如 CE/EE AccessControl、observability；实现 SDK 的端口，但不承载资源规则 |
| `packages/agent/agent-runtime` | `platform-sdk`（仅 manifest/通用契约需要时）、无业务语义基础依赖 | `resources`、具体 AccessControl、`apps` | 只负责引擎适配与执行能力，不理解资源、actor 或权限 |
| `packages/agent/agent-instance` | `agent-runtime` 的公开入口、无业务语义基础依赖 | `resources`、`platform` 的具体授权实现、`apps` | 只管理实例生命周期；不得把资源授权塞入 InstanceManager |
| `packages/resources/<resource>` | `platform-sdk`、本资源声明的基础依赖、其他资源包根入口公开的 service/DTO；按需依赖根入口公开接口 | `apps`、具体 AccessControl、其他资源的内部 `src/**`、repository/schema | 资源的授权只依赖 `AccessControlModule` 契约；资源间规则见上一节 |
| `packages/resources/<resource>/web` | 本资源及其他资源 `./web` 公开的 DTO/API client/hook/组件、共享 UI、Web SDK | 所有服务端 `services`、`repositories`、db、adapter；其他资源 `web/src/**`；`apps/web` 内部 | 浏览器边界，不得把 server 代码带入 bundle |
| `apps/server` | 所有已启用包的公开入口 | 任意包内部路径 | 唯一的 server 装配根：读取 profile、注入依赖、挂载 route、注册生命周期 |
| `apps/web` | 资源 `./web` 公开入口、Web 契约、版本自己的 Shell | 服务端实现、resource 根入口中的 server-only 导出 | 最终 Web 装配根；Shell 属于 app，不属于资源包 |
| EE package / app | CE submodule 的公开 `@fenix-ce/*` 入口、EE 自身公开入口 | CE 内部路径；CE 反向依赖 | 依赖方向只能是 `EE → CE`，以便 CE 独立构建与发布 |

推荐的总体方向如下：

```text
                         apps/server · apps/web
                                  ↓
            platform 具体实现 · resources · agent
                     ↓              ↓        ↓
                         platform-sdk

EE packages/apps ─────────────────────────→ CE public packages
CE packages/apps ─────────────────────────╳ EE packages/apps
```

`fenix.module.ts` 的 `dependsOn` 是**装配依赖**，表示一个 manifest 被 profile 启用时需要同时启用哪些模块；它不能取代 TypeScript 的 `package.json` dependency，也不能放宽上述编译依赖规则。反过来，两个包存在 TypeScript 依赖也不必然意味着它们必须在每个 assembly profile 中同时启用：是否需要共同启用取决于其公开能力是否在该 profile 中被实际装配。

### 2.3 配置驱动的静态装配

配置文件用于在**已编译进当前镜像/bundle**的模块中选择组合，例如 `deploy/assembly/ee.json`：

```json
{
  "accessControl": "enterprise",
  "runtime": "shared-agent-runtime",
  "resources": ["agent-config", "agent-config-publication"],
  "web": ["enterprise-agent-config"]
}
```

CE 的 `platform-sdk/assembly` 提供唯一的 `AssemblyProfile` 与 `parseAssemblyProfile()`：它只校验授权、runtime、Shell、资源和 Web 模块 ID 列表的通用结构，不知道 CE/EE 的具体 ID。CE、EE 各自只加载自己的 profile JSON/YAML；随后由对应 app 对生成 registry 做 ID、类别和依赖校验，不复制 parser，也不将 EE 字段加入基础契约。

每个可装配包在根目录导出 `fenix.module.ts`，声明稳定 `id`、`kind`、`dependsOn`、资源 module、基础模块工厂及可选 web contribution。构建脚本扫描受版本控制的 `packages/**/fenix.module.ts`；EE 同时扫描固定 submodule 的 `vendor/fenix-ce/packages/**/fenix.module.ts`，生成仅含静态 `import` 的 `apps/generated/module-registry.ts`。app 不手写注册表。

启动流程依次执行：读取 JSON/YAML → 校验结构和重复 ID → 从**生成 registry**确认 ID 和类别 → 校验 manifest 依赖、capability 冲突、所需 env 与 migration preflight → 创建依赖并挂载 route/web contribution。profile 可随镜像交付，也可作为受部署平台保护的只读挂载文件在启动时读取；其位置由发布脚本固定，不能由 profile 自己指定。配置中禁止出现任意文件路径、URL、npm 包名、表达式或代码片段；它不能 import、下载或执行新代码。

因此，已有模块的启停、替换和组合可以只改装配配置；新增模块只需提供 package、manifest 和 assembly ID，再运行 registry 生成脚本，**不需修改 app 注册逻辑**。改变模块实现或 manifest 契约仍必须提交代码，并走正常构建、迁移及发布验证。server 与 web 可读取同一 profile 的不同区段，但 web 只消费已进入浏览器 bundle 的 contribution，绝不从配置加载远程脚本。

## 3. 后端路由与服务组织

### 3.1 路由按“协议 + 领域贡献”组织

`apps/server/src/routes` 只保留协议聚合器：

```text
apps/server/src/
├── bootstrap.ts                    # 创建依赖、装配模块、注册关闭钩子
├── routes/
│   ├── app.ts                      # 挂载所有 /app 模块贡献
│   └── protocols.ts                # ACP、MCP、Webhook、SSE、WS 等协议贡献
└── index.ts                        # 进程入口
```

领域路由随模块存在，例如 `createAgentConfigAppRoutes({ facade, logger })`。route 负责协议校验、认证上下文提取、DTO 转换、调用 service、错误映射和接口元数据；不直接访问 db，不写跨表事务，不调用别的 route。

路由前缀规则：

| 前缀 | 消费者 | 规则 |
| --- | --- | --- |
| `/app/*` | 控制台与受控的程序调用方 | 唯一业务 HTTP 接口；统一认证、DTO、响应 envelope 与错误码 |
| `/acp/*`、`/mcp/*`、`/hooks/*`、WS/SSE | 协议/内部桥接 | 独立协议契约，不作为第二套资源业务 API |

非 CRUD 动作使用资源动作后缀，如 `POST /app/agent-configs/:id/run`、`POST /app/agent-configs/:id/publish`。动作始终进入资源 services 层，再经端口调用 runtime。

本阶段不维护 `/api/*` 这一套外部 API。`/app/*` 不是“只允许浏览器调用”：认证模块可按同一主体模型识别 session、服务账号或受控 API Key，但所有调用方使用同一 DTO、授权和错误契约。若未来确需面向第三方提供稳定开放平台，须以独立 ADR 决定公开契约、限流、版本和兼容策略；不得在资源模块内重新复制 `/api/*` route。

### 3.2 服务与 repository

默认依赖方向：`routes → Resource Facade → Domain Service / repositories / adapters`。Facade 是外部资源操作入口，负责 actor 授权、状态校验、跨资源编排、事务、幂等性和外部调用；Domain Service 只处理资源自身领域规则与数据访问，不接受 actor，也不做用户权限校验；repositories 只封装存储查询和事务原语；adapters 只处理外部协议或 Provider 差异，不能承载领域规则。

资源之间可直接引用对方包根入口公开的无权限 Domain Service；授权由发起动作的 Resource Facade 统一完成，不在同一次编排中重复校验被依赖资源的用户权限。

全局系统管理员仍是带真实 `userId` 的用户 actor，由 `AccessControlModule` 根据系统管理员身份放行系统级动作，以保留审计主体。迁移、运维和模块内部调用不构造 actor，直接使用受信任的 Domain Service；当前不定义 `system` actor。

普通用户的资源列表必须通过 `AccessControlModule` 及统一授权查询能力，将声明式查询约束下推为数据库条件；系统管理 Facade 在完成系统管理员校验后、以及受信任模块内部调用可复用无权限 Domain Service 的列表查询。禁止 service 先读全量数据再按组织、角色或版本过滤；Repository 不得自行读取 member/role、归属字段、scope 或 grant 表并复制授权 SQL。

### 3.3 授权范围与资源查询约束

CE 的归属存储尚未在 `access_scope`、固定归属字段加 grant 表、统一 `resources` 基表三种方案间定稿。无论最终选择哪种，资源领域、route、前端和普通 Repository 都不得理解 CE 的组织、用户、角色、归属、scope 或 grant 存储细节；EE 也不使用或兼容 CE 的物理权限表，只实现相同的上层访问接口。

`AccessControlModule` 负责回答“当前主体可以看哪些资源范围”和“是否允许操作单个资源”。平台的统一授权查询能力负责将其编译为当前存储方案所需的 Drizzle 条件。资源 Repository 只声明资源类型、主键列与业务条件，例如 `authorizedQuery.list({ resourceType, resourceIdColumn, businessWhere, access })`，不编写 member/role 判断或授权 SQL。

授权关联数据需要参与查询时，优先由统一实现生成相关子查询 `EXISTS`，而不是让资源查询直接 join grant 表。例如“默认归属/公开条件 OR 存在匹配 read grant”。`EXISTS` 不会因多条 grant 重复资源行，PostgreSQL 通常可将它优化为 semijoin；授权表按主体、动作、资源 ID 的实际查询方向建组合索引，并用 `EXPLAIN ANALYZE` 验证。业务模块不拼接这段 SQL。

完整的稳定接口、候选存储方案与迁移边界见 [CE 用户、组织与资源权限模型设计](./ce-access-control-design.md)。因此授权约束属于 **授权与资源查询的契约**；数据库章节只规定各存储实现必须正确编译、测试它。

## 4. 前端与控制台组织

### 4.1 前端分为壳和功能模块

```text
apps/web/src/
├── routes/                 # 文件路由的薄适配层；只连接页面与路由参数
├── app.tsx                 # Provider、错误边界、模块注册
└── shell/                  # 本版本最终壳：布局、首页、导航、品牌、Provider、鉴权后壳

apps/generated/
└── module-registry.ts      # 构建期生成的资源 web contribution 静态 import

packages/resources/<module>/web/
├── api/                    # 调用 /app 的类型化客户端
├── pages/                  # 领域页面与容器
├── components/             # 领域组件
├── hooks/                  # 本领域数据和状态逻辑
├── i18n/                   # 本领域翻译资源
└── contribution.ts         # 导航、权限提示、页面元数据、路由目标声明
```

TanStack Router 仍保持文件路由：应用的 `routes/` 是薄文件，静态导入选定资源模块 `web/` 子路径的页面。不要尝试运行时注入路由；EE 添加页面时在 EE web app 建立 route adapter，或由 EE 资源模块的 `web/` 提供页面，再由 app 显式注册。

`WebShell` 是版本级产品组合，不是资源模块，也不放入 `packages`。CE 在 `ce/apps/web/src/shell/CommunityAppShell.tsx` 持有 CE 首页、布局、社区导航和全局 Provider；EE 若有整体差异，则在 `ee/apps/web/src/shell/EnterpriseAppShell.tsx` 持有企业首页、SSO 初始化、企业导航和布局。EE Shell 不继承、也不通过覆盖 CE Shell 的局部 hook 实现差异。

assembly 的 `webShell` 显式选择当前 app 自己提供的唯一最终壳，`web` 列表则选择构建期生成 registry 中的资源页面 contribution：

```text
assembly.webShell → apps/web 的 CommunityAppShell 或 EnterpriseAppShell
assembly.web      → generated module registry → resources/*/web contribution
```

因此，资源页不能反向决定全局布局；Shell 可收集已启用资源模块的导航、路由和页面 contribution，但不得导入资源模块的 server service、repository 或 db。若将来确实有两个以上独立 Web 应用复用同一完整 Shell，才把已稳定的 Shell 实现抽取为 package；即使如此，`apps/web` 仍是最终选择和装配入口。

### 4.2 前端差异化规则

“复用领域服务，EE 扩展流程”在前端同样成立，但前后端扩展独立：

1. **无 UI 差异**：EE 复用 CE `resources/agent-config/web` 页面和 API client。
2. **局部差异**：EE 复用 CE API client、DTO、通用表格/表单组件，在 `resources/enterprise-agent-config/web` 追加发布按钮、状态展示或审批页；不复制整个 CE 页面。
3. **页面流程整体不同**：EE 在自己的资源模块 `web/` 提供替代页面，并在 EE app 的静态 route adapter 中选择它；后端仍可复用 CE domain/repository。
4. **甲方品牌与导航差异**：由 `apps/web` Shell 的静态品牌/导航配置处理，不侵入资源模块。
5. **首页、布局或全局交互模型整体不同**：在 EE/甲方自己的 `apps/web/src/shell` 实现完整 Shell，并以 assembly 的 `webShell` 选择；资源模块的 API client、DTO 和页面仍可按实际差异复用。

前端只能通过 API client 取数，必须覆盖 loading、empty、error、retry、无权限和成功反馈；用户可见字符串进入模块 i18n。前端的“可见/不可见”仅是体验，服务端 services 授权才是安全边界。

## 5. 环境变量与配置

### 5.1 单一启动校验与模块声明

环境变量对一个 server 进程只有一份：启动时统一读取、统一校验一次。业务模块**不自行读取** `process.env`，也不各自加载 `.env` 文件；它只声明自己确实需要的部署级配置，并由 `apps/server` 将已校验的配置注入构造函数。

绝大多数资源模块不需要 env。例如 AgentConfig 的名称、模型、Skill、发布状态是数据库业务配置，不是环境变量。只有数据库连接、对象存储、模型网关、Sandbox 地址、第三方密钥等“部署时确定、重启后才变化”的配置才声明 env。

```ts
// packages/agent/agent-runtime/fenix.module.ts
// 下例仅说明模块如何声明并消费环境变量；当前 demo 没有额外 adapter 模块。
export const moduleManifest = {
  id: "agent-runtime",
  kind: "runtime",
  envDefinitions: [
    { moduleId: "agent-runtime", key: "RCS_AGENT_RUNTIME_ENDPOINT" },
    { moduleId: "agent-runtime", key: "RCS_AGENT_RUNTIME_TOKEN", secret: true },
  ],
  create(context) {
    // 只消费 bootstrap 已校验并注入的 config；绝不读取 process.env。
    return createAgentRuntime({
      endpoint: context.env.RCS_AGENT_RUNTIME_ENDPOINT,
      token: context.env.RCS_AGENT_RUNTIME_TOKEN,
    });
  },
};

// apps/server/src/bootstrap.ts
const installedModules = resolveEnabledModules(assemblyProfile, generatedModuleRegistry);
const env = loadServerEnv([
  ...serverHostEnv, // 仅 PORT、日志级别、关闭超时等进程级配置
  ...installedModules.flatMap((module) => module.envDefinitions ?? []),
]);
const application = assembleApplication({ installedModules, env });
```

`bootstrap.ts` 不直接 import 或调用具体模块工厂，例如 Agent runtime、PostgreSQL client 或对象存储 client。它只解析 assembly、取得已启用 manifest、统一读取/校验 env，并将按模块切分后的配置交给装配器/模块工厂。当前最小 demo 仅展示 schema 与 migration 的组织方式，不模拟数据库连接或 PostgreSQL 模块；真实工程接入数据库时，由负责存储的模块声明连接配置并接收注入，repository 只接收已构造的 db client，不读取连接串。

`envDefinition` 至少声明字段名、Zod schema、默认值、是否 secret、是否 restart-required、所属模块和用途说明。加载器合并所有静态装配模块的声明；同名字段的 schema、默认值或 secret 属性不一致时启动失败，EE 只能追加自己的定义，不能静默改变 CE 同名变量语义。

```text
CE server env = server host env + CE profile 启用模块的 env
EE server env = server host env + EE profile 启用的 CE/EE 模块 env
```

前端 `apps/web` 不读取 server env，也永远拿不到 secret。它的少量公开构建配置（例如公开服务地址、构建版本、品牌默认值）由独立的 `webEnv` 声明并在构建时注入；更适合运行时变化的品牌、导航和功能开关则从受控的 `/app` 配置接口读取。

### 5.2 配置文件与密钥规则

- `deploy/env/*.example` 是部署模板的真相来源，只有变量名、说明和非敏感样例；真实 `.env` 永不提交。
- 密钥来自部署平台 secret store、Docker/K8s secret 或受控文件，应用日志、错误响应、测试 fixture 和诊断包均不得输出其值。
- 子进程、Sandbox、Provider 只能获得按模块显式构造的环境白名单，不能透传整个 `process.env`。
- 可运行时修改的业务配置（例如 AgentConfig）存数据库；环境变量只存部署级、连接级和启动级配置。

## 6. 数据库、Drizzle 与数据迁移

### 6.1 Schema 所有权

关系型主存储默认 PostgreSQL + Drizzle。表和索引的 Schema 只在模块内维护；根目录的 `drizzle.config.ts` 只是 Drizzle 工具配置，不定义或 re-export 任何表：

```text
packages/resources/agent-config/db/schema.ts         # 模块拥有字段语义
packages/resources/agent-config/db/data-migrations/  # 模块拥有的业务数据迁移
drizzle.config.ts                                    # schema: [模块 schema 文件路径...]，仅供生成工具读取
db/migrations/                                       # 本仓库生成的不可变 DDL 链
```

例如 CE 的配置直接列出已装配模块：

```ts
schema: [
  "./packages/platform/identity/db/schema.ts",
  "./packages/resources/agent-config/db/schema.ts",
]
```

EE 的 `drizzle.config.ts` 只列出 **EE 自己拥有的** schema 文件。EE schema 如需引用 CE 表，可从 CE 的公开 db 子路径导入该表作为外键目标，但不 re-export 该 CE 表，也不将 CE schema 文件列入 EE 的 `schema` 数组。这样 Drizzle 只为 EE 表生成 SQL，CE 表由先执行的 CE migration 保证已存在。

部署迁移顺序固定：`CE migrations → EE migrations → EE data migrations`。CE、EE 使用不同 migration journal（例如 `__drizzle_migrations_ce`、`__drizzle_migrations_ee`），避免两个仓库争用同一迁移记录。EE 对 CE 表的依赖以 submodule 固定提交为准。

### 6.2 EE 新增表的具体流程

以 EE 为 AgentConfig 新增发布状态为例：

```text
1. EE：packages/resources/enterprise-agent-config/db/schema.ts
   定义 agent_config_publications 表。
   可引用 CE 的 agent_configs 表作为外键目标。

2. EE：drizzle.config.ts
   schema 只列出 enterprise-agent-config 等 EE 模块的 db/schema.ts。
   out 指向 EE/db/migrations。

3. 在 EE 根目录执行：
   bun run db:generate --name agent-config-publication

4. 审查新生成的 EE/db/migrations/<timestamp>_agent-config-publication.sql
   它只应创建/修改 agent_config_publications 等 EE 表。

5. 发布时：先运行 vendor/fenix-ce 的 migration runner，
   再运行 EE 的 migration runner，最后执行 EE 模块的数据迁移。
```

EE 不得用 migration 修改 CE 拥有的表。若商业需求必须改变 CE 表结构，应先在 CE 增加通用字段/扩展点并发布，再升级 EE submodule；若是 EE 专属数据，使用 EE 扩展表，以 `agent_config_id` 等稳定 ID 关联 CE 表。

### 6.3 迁移规则

1. 变更模块 schema，更新模块 schema manifest。
2. 通过仓库的 `db:generate --name <module>-<change>` 生成当前仓库 migration。
3. 审查 SQL、snapshot、journal；DDL 仅处理结构。
4. 有存量数据时，新增独立、幂等、可观测的数据迁移；记录完成标识与批次进度。
5. CI 对空库和升级库都执行 migration smoke test；生产先备份并执行 migration preflight。

生产演进采用 expand → backfill → switch → contract。应用版本在删列/收紧约束前必须兼容前一版本数据；失败迁移应新增补偿迁移，禁止改写已发布 migration。

### 6.4 数据迁移按模块就近维护、按仓库统一执行

数据迁移依赖资源字段、历史状态和业务不变量，因此代码与 schema 一样归所属模块维护：

```text
packages/resources/agent-config/db/data-migrations/
└── 20260906-backfill-launch-source.ts
```

根 `db/data-migration-runner.ts` 不放迁移业务逻辑，只在发布任务中静态汇总已装配模块导出的 migration manifest，做依赖排序、分批执行、日志/指标、失败停止和完成记录。每个迁移使用全局唯一 ID，例如 `agent-config/20260906-backfill-launch-source`，并声明：

- `dependsOn`：必须已完成的 DDL 或数据迁移 ID；
- `run(context)`：可重试、幂等、按批处理的迁移实现；
- `verify(context)`：确认迁移结果完整的校验；
- `compensation`：失败或回滚时的补偿方案；
- 预期数据量、锁风险和可观测字段。

跨模块数据迁移应归属发起变更的模块，并显式声明依赖；不能为了复用而让迁移调用运行中的 service，因为该 service 的当前业务行为可能已经不兼容历史数据。迁移使用受限的 repository/SQL adapter，且只由部署发布任务执行，不在每个应用进程启动时自动执行。

### 6.5 更换存储 DB 的方案

先区分两种情况：

| 场景 | 推荐方案 |
| --- | --- |
| 文件、Skill 包、附件、日志归档、向量库等领域存储替换 | 在对应资源/Provider 端口新增 adapter；关系型元数据保持不变；静态装配选择 adapter |
| 关系型主库从 PostgreSQL 改到其他 DB | 这是基础设施替换，不是替换 Drizzle driver；为所有 repository port 提供新 adapter、事务实现、索引/约束方案和迁移工具 |

新 DB 必须正确编译第 3.3 节的授权查询约束，并通过同一 repository contract test suite；同时提供全量迁移、双环境校验、备份和回滚方案后才能切换。

不允许为了“支持多 DB”在 domain/services 中加入 `if (databaseType)`；也不在没有第二种实际实现前提前抽象所有 Drizzle 细节。

## 7. 日志、审计、指标与追踪

`platform/observability` 定义稳定端口，应用注入具体实现：

```text
Logger       # 结构化运行日志：debug/info/warn/error
AuditRecorder# 不可抵赖的业务审计：谁在何时对什么资源做了什么动作
Metrics      # 计数、耗时、并发、队列、资源用量
Tracer       # 跨 HTTP、任务、ACP、Provider 调用的 trace/span
```

运行日志不是审计日志，二者分别保存、保留和授权。每条日志尽可能携带 `requestId`、`traceId`、`module`、`operation`、`actorId`（可脱敏）、`scopeKind/scopeId`、`resourceId`、`instanceId` 和错误原因；禁止记录 token、Cookie、密码、连接串、完整 prompt/文件内容和未脱敏外部响应。

规则：

- route 在入口建立 request/trace context；异步任务、实例、队列、relay 必须显式传播。
- services 记录关键状态转换；adapters 记录重试、超时和外部依赖失败；不在每层重复记录同一错误。
- `run`、`publish`、授权拒绝、身份/权限配置变更、部署与迁移必须写 audit event。
- 控制台系统日志页只读取经过权限过滤的日志投影；不得直接暴露底层日志文件。
- JSON stdout 是容器默认输出；文件归档、日志平台、指标/trace exporter 都是部署期静态 adapter。

## 8. 部署、构建和运行脚本

`scripts/` 只做薄编排，不承载业务逻辑：

| 脚本 | 职责 |
| --- | --- |
| `check-module-boundaries` | 检查禁止依赖、公开入口与 submodule 未修改 |
| `build-release` | 构建 server/console、生成版本与 SBOM 信息 |
| `migrate-ce` / `migrate-ee` | 分别运行带独立 journal 的 DDL 迁移 |
| `run-data-migrations` | 执行已登记且幂等的数据迁移 |
| `deploy-preflight` | 校验 env、DB 连通性、迁移状态、镜像版本和依赖服务 |
| `release` | 串联 preflight、迁移、部署、readiness、回滚判断 |

`deploy/compose` 使用“基础编排 + 可选 profile/overlay”：主服务、数据库、模型网关、知识库、Sandbox 等可独立启停。模块声明其依赖服务与健康检查；部署入口根据静态装配的模块生成/选择 profile，而不是由业务代码自行启动 Docker。

发布顺序：备份与 preflight → CE migration → EE migration → data migration → 部署新镜像 → readiness/关键链路探测 → 流量切换。代码回滚与数据库回滚分开决策；只允许回滚到仍兼容当前 schema 的镜像，否则先做补偿 migration。

## 9. Git submodule 升级流程

EE 根 `package.json` 将 `vendor/fenix-ce/packages/*/*` 纳入 workspace，EE 代码仅从 CE 包公开入口导入。CE 的公开包遵循语义化兼容承诺，并在每个 release tag 产出：变更日志、兼容性说明、migration manifest、环境变量变化和废弃项。

升级步骤：

1. CE 发布不可变 tag；EE 创建独立的 `chore/upgrade-ce-<tag>` 分支。
2. 在 `vendor/fenix-ce` 显式 checkout 该 tag/commit，更新 submodule 指针与锁文件；禁止 `--remote` 无审查更新。
3. 读取 CE release compatibility manifest，审查破坏性 API、DB、env、部署变化。
4. 执行 EE 的类型检查、模块边界检查、CE/EE migration upgrade test、最小启动链路和关键端到端测试。
5. 若 EE 需要适配，在 EE 自己的模块中完成；不得修改 submodule。不能兼容则停止升级或先在 CE 提供正式扩展点。
6. 审查完成后合并；发布镜像记录 CE commit、EE commit、migration 版本。

CI 必须验证 `git diff --exit-code -- vendor/fenix-ce`，确保 submodule 只有合法指针变更。紧急回退优先回到上一个已验证的 CE 指针和 EE 镜像；数据库按 expand/contract 规则判断可否回退。

## 10. 扩展方案决策表

| 需求 | 放置与做法 | 禁止做法 |
| --- | --- | --- |
| 替换身份、租户、权限 | 在 platform 实现 `AccessControlModule`，app 静态替换 | 在资源 service 中读取 CE member/role 表 |
| `AccessControlModule` 缺能力 | 见 10.1 | 给现有接口塞客户专属 optional 字段或 `as any` |
| EE 对资源增加发布/审批/版本 | EE resources 包：自有 schema、状态机、Facade 覆盖/组合、route/web contribution | 修改 CE 资源表加入 EE 字段，或复制 CE CRUD |
| 前端局部/整体差异 | EE 资源模块的 `web/` 复用 API client/组件或替换页面，在 app 静态选择 | fork 整个 CE web app、运行时注入路由 |
| 新增从未有过的业务功能 | 新建 EE resource/agent/web 模块，声明依赖、schema、routes、UI、测试 | 将功能塞进 platform-sdk 或 app.ts |
| 新引擎/RAG/MCP/Sandbox/部署目标 | 实现对应静态插件 SDK，app 选择 provider | 将 provider 特例写进 domain service |
| 更换存储 | 为 repository/provider port 新增 adapter，并完成迁移与 contract test | domain 内判断 DB 类型 |

### 10.1 扩展 `AccessControlModule` 的准则

先判断新需求的语义归属：

1. **所有资源都必须具备的基础授权语义**（如主体、写入归属、读写查询约束）进入下一版 `AccessControlModule`；CE 与 EE 实现随同 submodule 升级一起适配。这是明确的契约演进，不做兼容 shim。
2. **某领域独有的策略**（如 AgentConfig 发布审批人、Workflow 审批节点）在消费领域定义窄端口，例如 `AgentConfigApprovalPolicy`；EE access-control 实现可同时实现它，app 显式注入给 AgentConfig 模块。
3. **客户独有策略**放客户 EE 模块，不污染 CE 通用接口。

禁止通过 `accessControl as any`、`"method" in accessControl` 或全局 callback 注册表偷偷获得扩展能力。每个新增授权端口必须定义输入、输出、查询约束、拒绝语义、审计事件和 contract test。

#### 示例 1：EE 的 AgentConfig 发布审批（领域独有策略）

“谁可读取/修改/使用 AgentConfig”仍是基础 `AccessControlModule` 的职责；“谁可以将它发布到生产环境”只属于 AgentConfig 的发布领域，因此不应给所有资源的基础接口增加 `canPublish()`：

```ts
// packages/resources/enterprise-agent-config/src/services/approval-policy.ts
export interface AgentConfigApprovalPolicy {
  authorizePublish(input: {
    actorId: string;
    agentConfigId: string;
    scope: unknown;
  }): Promise<void>;
}

// EE platform：同一个身份/授权实现可同时实现两个明确端口。
export class EnterpriseAccessControl
  implements AccessControlModule, AgentConfigApprovalPolicy {
  async authorizePublish(input): Promise<void> {
    // 检查企业工作空间的“配置发布人”权限；拒绝时写审计事件。
  }
}

// EE AgentConfig Facade：显式依赖窄端口，而不是向基础 AccessControlModule 强转。
export class EnterpriseAgentConfigFacade {
  constructor(
    private readonly accessControl: AccessControlModule,
    private readonly approvalPolicy: AgentConfigApprovalPolicy,
  ) {}
}

// apps/server：构建期明确装配。
const accessControl = new EnterpriseAccessControl();
const agentConfigs = new EnterpriseAgentConfigFacade(accessControl, accessControl);
```

这样 CE 不认识发布审批，其他资源也不会被迫实现无关方法；EE 仍可使用同一套企业身份数据。

#### 示例 2：甲方的合规审批（客户独有策略）

假设甲方 A 要求“涉及 `finance` 工作空间的 AgentConfig，必须由外部合规系统批准后才能发布”，而普通 EE 客户只需要企业发布人权限。甲方代码新增自己的模块：

```text
packages/resources/customer-a-agent-config-approval/
├── src/customer-a-approval-policy.ts  # 调用甲方合规系统、记录 approval ticket
└── web/                                # 显示合规状态与提交审批按钮
```

它实现同一个 `AgentConfigApprovalPolicy`，并在甲方版本的 `apps/server` 静态替换 EE 默认实现：

```ts
const accessControl = new EnterpriseAccessControl();
const approvalPolicy = new CustomerAAgentConfigApprovalPolicy({ complianceClient });
const agentConfigs = new EnterpriseAgentConfigFacade(accessControl, approvalPolicy);
```

CE 的 `AccessControlModule`、EE 的基础 AgentConfig CRUD 和其他客户均无需修改。若甲方需求将来被证明是多个客户共同需要的企业能力，再将该窄端口的默认实现上移到 EE；不要先把客户字段或方法加入 CE。

## 11. 对现有工程切面的覆盖

以下是本文架构对 `FUNCTIONAL_MODULE_INVENTORY.md` 所列功能分类的落位。它覆盖所有横切面；后续重构时每个具体模块仍需单独编写 migration/design，而不是一次性重写。

| 当前功能分类 | 目标落位/扩展模型 |
| --- | --- |
| 身份、组织、API Key、资源权限 | platform identity/tenancy/access-control；可整体替换 |
| Agent 配置、Skill、MCP、模型、知识库、环境、站点 | resources；基础 CRUD + 各自 domain/services；Provider 用静态插件 |
| 实例编排、引擎、ACP、relay、会话控制 | runtime；不承载资源授权 |
| Chat、YJS、文件、机器、Sandbox | runtime 或资源基础模块；存储/transport/provider 为静态 adapter |
| 工作流、任务、Webhook、调度 | 独立 resources/runtime 模块；节点、执行器、触发器为静态插件 |
| 控制台壳、导航、业务页面、品牌 | apps/web 壳 + resources 模块内的 `web/`；静态 contribution |
| 应用 HTTP、MCP/ACP/Webhook/SSE/WS | 模块 server route contribution + app 协议聚合 |
| DB、数据迁移、日志、指标、部署、系统管理 | 仓库级 `db/`、`deploy/` 与 platform observability；模块显式贡献 |

因此，当前已知切面均有归属：领域差异走 resources/console，身份差异走 platform，执行差异走 runtime/provider，交付与治理走 apps/db/deploy/docs。尚未覆盖的是每个功能的详细数据模型、迁移顺序和 API 兼容清单，它们应在逐模块重构计划中补齐。

## 12. 开发与验收规则

每个模块变更必须：

1. 明确模块归属、依赖方向、授权/租户边界、失败和并发语义。
2. 更新模块 README；影响长期边界时更新 `docs/arch` 或 ADR；待讨论方案放 `docs/design`。
3. 修改 `/app` route 时同时更新接口 schema；修改 web 时覆盖 loading、empty、error、retry、i18n 与无权限体验。
4. 修改 schema 时生成、审查并执行 migration；有数据变化则提供独立幂等 data migration 和回滚/补偿说明。
5. 修改 env、部署或可观测性时同步 `deploy/env` 模板、operations 文档和 preflight。
6. 运行模块单测、契约测试、类型检查、lint/format；涉及 CE/EE 边界时运行 submodule 集成和升级 migration 测试。

第一阶段重构只实现最小闭环：`platform-sdk + CE access-control + agent-config + agent-instance + agent-runtime + /app route + web page + PostgreSQL/Drizzle + observability + deploy preflight`。其余模块按本规范逐个迁移，不引入平行的旧/新授权或资源路径。

## 13. 从当前 CE 工程迁移到目标架构

### 13.1 总体策略：按垂直切片迁移，不做大爆炸重写

当前 `src/`、`web/`、根 `drizzle/` 和 `docker/` 是正在运行的 CE。迁移目标不是先搬空目录再补功能，而是每次迁移一个可独立验证的模块闭环：数据归属 → domain/services/repositories → `/app` route → `resources/<module>/web` → 测试与观测 → 删除旧实现。

允许“已迁移模块”和“尚未迁移模块”在同一仓库短暂共存；但同一个资源、同一个 route、同一张表的写入逻辑在任一时刻只能有一个权威实现。禁止新增旧/新 service 双写、兼容 facade 或长期转发层。

### 13.2 阶段与顺序

| 阶段 | 具体操作 | 完成标准 |
| --- | --- | --- |
| 0. 基线冻结 | 基于 `FUNCTIONAL_MODULE_INVENTORY.md` 为所有现有模块标明目标归属、调用方、表、route、web 页面、外部依赖和迁移风险；补齐关键链路回归测试与观测基线 | 可比较重构前后行为、性能和错误率 |
| 1. 工程骨架 | 创建 `apps/server`、`apps/web`、platform/agent/resources 目录、workspace 与边界检查；将当前 server/web 入口一次性移入 apps，修正构建、测试、Docker 入口 | 不改业务行为，原测试与部署可运行 |
| 2. 平台基础 | 抽取 `platform-sdk`、CE `community-access-control`、observability、统一 env loader、DB client/transaction adapter；定义稳定的 `AccessControlModule`、授权查询能力与 repository contract | 新模块不再直接读取 member/role 或 `process.env` |
| 3. 最小闭环 | 迁移 AgentConfig、其 `/app` route、`web/` 页面、`AgentInstanceManager`、Agent runtime；用此闭环验证授权、发布扩展和实例边界 | demo 的设计在真实 CE 最小能力上成立 |
| 4. 资源目录 | 依赖从低到高迁移 Skill、MCP、模型/Provider、知识库、记忆、环境等；每个资源独立完成 schema、授权、route、web 和删除旧代码 | 资源不再散落在 `src/services/config` 与 `web/src/pages` |
| 5. 执行与连接 | 迁移 Machine、workspace/file、Sandbox、引擎插件、ACP relay、实例编排；保持 runtime 不读取资源权限 | 运行、文件和节点能力通过公开端口连接 |
| 6. 自动化与协作 | 迁移 Chat/YJS、Workflow、Scheduler、Webhook、Channel；节点/执行器/Provider 采用静态插件点 | 长连接、恢复、调度等关键边界有专项测试 |
| 7. 交付与治理 | 迁移 Site/Product View、系统管理、deploy、operations docs、release/preflight；删除旧根目录结构和过时文档 | 新目录是唯一入口，CI 强制边界规则 |

阶段 3 是商业版启动门槛；阶段 4 以后按业务价值逐模块推进，不等待所有历史功能迁移才开始 EE。

### 13.3 每个资源模块的固定迁移操作

以当前 AgentConfig 为第一个真实切片，后续 Skill、MCP、知识库等完全套用：

1. **盘点与定界**：列出当前 service、repository、schema、route、页面、后台任务、外部 API、引用该资源的其他模块；确定资源归属、读/写/use 动作、数据隔离和删除条件。
2. **创建模块骨架**：创建 `packages/resources/<resource>/{src,db,web}` 和 README；先定义公开 DTO、repository port、模块 capability 与 route/web contribution，不复制旧 service。
3. **迁移 schema 所有权**：将该资源表定义移动到模块 `db/schema.ts`，更新根 `drizzle.config.ts` 路径列表。仅移动源码而未改变表结构时，必须生成并审查“无 DDL 差异”结果；不得创建重复表。
4. **迁移数据隔离**：按最终确定的权限存储方案执行 expand → backfill → switch → contract；回填现有组织归属、owner、公开与分享数据，切换为 `AccessControlModule` 统一授权查询，验证后删除旧授权查询路径和废弃字段。
5. **迁移领域与 services**：将字段校验、状态机按需放入 domain；将授权、事务、动作编排放入 service/facade。所有调用方在同一切片改为新公开入口，随后删除旧 service/repository。
6. **迁移资源动作**：资源的 `run`/`publish` 等动作在 services 的 facade 完成授权与状态检查，再调用 runtime port；runtime 只接收通用已解析参数。
7. **迁移 HTTP 与 web**：新增该资源的 `/app` route contribution，以及模块内 `web/` 页面/API client；`apps/web` 添加薄 route adapter。调用方切换后删除旧 `/web`、`/api` 和旧页面，不保留长期 alias。
8. **补齐迁移与观测**：有存量数据时在模块 `db/data-migrations/` 新增幂等迁移；补充结构化日志、审计事件、指标、错误码和权限拒绝测试。
9. **验收与删除**：运行模块、契约、route、web、迁移升级测试和 `precheck`；确认无旧入口引用后删除旧文件、旧 route、旧 i18n key 与旧文档。

### 13.4 AgentConfig 首切片的具体落位

当前实现可按以下映射开始，具体文件名在实施计划中确认：

| 当前位置 | 目标位置 | 处理方式 |
| --- | --- | --- |
| `src/services/config/agent-config.ts`、相关 repository | `packages/resources/agent-config/src/{domain,services,repositories}` | 拆出纯配置规则、授权 facade、持久化 repository |
| `src/db/schema.ts` 中 AgentConfig 及绑定表 | `packages/resources/agent-config/db/schema.ts` | 原表原 ID 移动定义；绑定资源按所属关系逐步迁移 |
| `src/routes/web/config/agents.ts`、`src/routes/api/agents.ts` | `packages/resources/agent-config/src/routes/` | 合并为 `/app/agent-configs` contribution；完成切换后删除旧双 route |
| `web/src/pages/*Agent*`、对应 API 文件 | `packages/resources/agent-config/web/` | 页面、API client、i18n 就近放置；`apps/web` 只留路由适配 |
| `src/services/instance*.ts`、`packages/orchestration/` 的实例职责 | `packages/agent/agent-instance` | 先定义 runtime port；不把 AgentConfig 权限带入 runtime |
| 引擎插件与 LaunchSpec 构建 | `packages/agent/agent-runtime`、`agent-engine-sdk` | 保持引擎多实现静态插件，资源层只输出通用启动参数 |

AgentConfig 关联的 Skill/MCP/知识库/环境在第一切片中只保留已验证的读取/解析端口；其自身 CRUD 和 web 页面在各自资源切片迁移。不要为了“完整 AgentConfig”阻塞第一个闭环。

### 13.5 路由统一为 `/app` 的迁移方式

当前 `/web/*` 与 `/api/*` 不应在新架构中长期共存。按资源切片执行：先完成新 `/app/<resource>` route、web client 和调用方切换；在同一发布窗口删除该资源旧 route。若已有无法立即迁移的外部调用方，必须先明确其停用窗口或单独设计开放平台，不得把旧 `/api` 无限期保留为兼容层。

协议入口（ACP、MCP、Webhook、SSE、WebSocket）不参与 `/app` 合并；迁移时只移动其代码归属和依赖注入，不改变其协议前缀或消息契约。

### 13.6 数据、发布与回滚规则

- **源码移动不是 DDL 变更**：迁移 schema 文件时先运行 migration diff，确认不会生成重复建表/删表 SQL。
- **结构变更先扩后缩**：新增字段/表、回填数据、切换读写、观察后再删除旧字段；每一步都有可观测信号和补偿方案。
- **一个资源一次只迁一个权威写路径**：旧 route/service 在切换完成后删除，不允许两个实现同时写同一资源。
- **发布顺序**：DDL migration → 模块 data migration → 部署新 server/web → readiness 与关键链路验证。数据库处于不兼容状态时不得直接回滚旧应用。
- **EE 开始时机**：CE 的 platform-sdk、community access-control、AgentConfig 和 runtime 最小闭环稳定后，即可创建 EE submodule；未迁移的 CE 历史模块暂不作为 EE 扩展点。

### 13.7 当前模块迁移优先级

1. platform：认证/组织上下文、资源授权、env、observability、DB transaction。
2. AgentConfig + Agent runtime + InstanceManager：形成首个商业可用闭环。
3. Skill、MCP、模型/Provider、知识库、环境：AgentConfig 最常引用的资源。
4. Machine、workspace/file、Sandbox、ACP/relay：执行与连接底座。
5. Chat/YJS、Workflow、Scheduler、Webhook、Channel：依赖运行闭环的自动化与协作能力。
6. Site、Product View、系统管理和剩余配置功能：按客户价值迁移。

每个阶段进入实施前都应形成独立的设计/实施计划，明确文件清单、数据库影响、测试、观测、发布和回滚，而不是按本文直接批量改造。

### 13.8 历史资源模型治理：标识、归属、权限与属性拆分

迁移不只是移动现有代码。发现资源模型不规范时，必须在该资源切片中一并修正；否则会把历史债务固化到新模块。当前至少统一处理以下两类问题。

#### A. 资源 CRUD 必须以稳定 ID 为准

`id` 是资源唯一、不可变、可被外键和 URL 安全引用的标识；`name` 只是可修改的展示属性，不能用于读取、更新、删除、运行或权限判断。

```text
正确：GET /app/agent-configs/:id
      PATCH /app/agent-configs/:id
      POST /app/agent-configs/:id/run

错误：GET /app/agent-configs/by-name/:name
      update({ name }) / delete({ name })
```

名称若需要在某个范围内唯一，应由资源主表的 scope 查询键与 `normalized_name` 建立相应唯一约束或表达式索引保证；若必须作为人类可读地址，应新增不可变或受控变更的 `slug`，仍不能用展示名替代 ID。导入/迁移程序可以在**明确 scope 和冲突策略**的前提下按名称查找，但业务 CRUD 不得如此实现。

对历史“按 name CRUD”的资源，执行顺序：

1. 盘点所有 name 调用点、名称重复数据和被其他表/配置引用的位置。
2. 为没有稳定 ID 的记录生成 ID；已有 ID 则沿用，禁止无必要重编号。
3. 将所有关联、route 参数、前端 selection、后台任务 payload、审计记录和权限引用回填为 ID。
4. 将 repositories/services/routes 改为只接受 ID；名称查询仅保留为列表搜索或显式的导入辅助能力。
5. 添加 ID 外键与名称唯一/slug 约束，执行重复名称数据修复。
6. 删除 name CRUD route、旧 service 方法和旧调用方；不存在长期 name→id 兼容转发。

#### B. 权限存储由 AccessControl 托管，领域逻辑不得理解权限

CE 最终可选择 `access_scope`、固定归属字段加授权关系表，或统一 `resources` 基表；此阶段不提前指定。无论物理模型如何，资源领域只保存或关联稳定资源 ID，且不读取、解释、写入组织、用户、角色、公开或分享的权限存储细节。

```text
资源 Service / Facade
├── 创建：AccessControl.initializeResourceAccess(...)
├── 详情、更新、删除、运行：AccessControl.authorize(...)
└── 列表：createListConstraint(...) → AuthorizedResourceQuery

授权实现（可替换）
├── access_scope：编译 JSON 条件
├── 固定归属 + grant：归属 WHERE + EXISTS grant
└── resources + grant：资源根记录条件 + EXISTS grant
```

资源 Repository 只传入资源类型、资源 ID 列和业务筛选条件，不能手写 member/role、scope 或 grant 查询。额外授权参与列表查询时，统一授权查询实现优先生成 `EXISTS` 子查询，避免直接 join grant 表导致多条授权重复资源行；PostgreSQL 可将其优化为 semijoin。

对现有“属性、组织归属、权限混在一张表”的资源，执行顺序：

1. 盘点现有组织、owner、公开和分享数据，按最终选定的物理模型制定回填规则。
2. 先切入稳定的 `AccessControlModule` 与 `AuthorizedResourceQuery` 调用接口，删除资源模块中直接读取 member/role 或拼授权 SQL 的逻辑。
3. 新增目标权限存储并回填数据；创建、更新、删除与授权侧写入/清理必须在同一事务中完成。
4. 校验记录数、ID 集合、归属、公开状态和关键列表结果；列表、详情与资源动作均使用统一授权入口。
5. 切换所有调用方后删除旧权限路径和废弃字段；不得长期双写。

该边界使 CE 业务领域不理解权限存储细节，EE 又可完全采用自己的资源表与连表授权查询。未来改变归属存储时，替换授权实现和回填数据即可，Route、Service、Web 与资源领域调用接口不变。

### 13.9 历史测试治理：隔离并发状态，删除测试专用注入

现有测试中若共享模块级变量、全局 auth/org context、`process.env`、数据库记录、文件目录、Redis/YJS key 或外部 mock，测试文件并行执行时会互相覆盖状态；改动无关逻辑也可能因执行顺序不同而失败。另一类历史问题是以 `setXxxForTest()`、可重置方法或模块级回调替换依赖，导致业务代码为测试暴露额外入口、可读性下降。

迁移目标是：**业务代码没有测试专用入口；每个测试拥有自己的状态和依赖实例；默认并行测试不共享可变外部状态。** 不以全局串行执行掩盖隔离问题。

#### A. 业务依赖在装配时固定，不在运行时被测试改写

禁止新增以下模式：

```ts
let credentialResolver: CredentialResolver | null = null;

// 禁止：仅为了测试而暴露可变的全局 setter。
export function setCredentialResolverForTest(resolver: CredentialResolver | null) {
  credentialResolver = resolver;
}
```

有真实外部依赖的能力，在创建时通过构造函数或工厂的依赖对象传入；纯领域逻辑不为了测试而增加依赖参数。例如：

```ts
export function createLaunchSpecBuilder(deps: {
  modelService: ModelService;
  skillService: SkillService;
  mcpService: McpService;
  credentialService: CredentialService;
}) {
  return {
    async build(input: BuildLaunchSpecInput): Promise<AgentLaunchSpec> {
      // 只使用创建时固定的 deps；不读取可变模块状态。
    },
  };
}
```

`apps/server` 用真实 Service 创建该对象；测试在自己的 fixture 中创建同一对象并传入 fake 或 test repository。fake、fixture、test clock 等只位于测试目录，不能作为业务 package 的 `set*ForTest()` 导出。资源间直接使用公开 Service 的规则不变；依赖创建方式不要求为每个方法额外增加测试参数。

#### B. 按测试类型隔离状态

| 测试类型 | 必须隔离的状态 | 标准做法 |
| --- | --- | --- |
| 纯领域单测 | 对象、clock、ID 生成器 | 每个 test 创建独立实例；不访问 DB、env、文件或全局单例 |
| repository 集成测试 | PostgreSQL 数据与事务 | 每个 test worker 使用独立 database/schema；或在所有访问均经注入 transaction 时使用每测试 rollback transaction |
| app/route 集成测试 | app、认证上下文、依赖图 | 每个 test 通过 `createTestApp()` 创建独立 app 和依赖；测试结束关闭连接/handle |
| Skill/文件测试 | 目录、归档、临时文件 | 每个 test 使用 `mktemp` 的独立目录；禁止写默认 `data/skills` |
| Redis、YJS、队列 | key、stream、consumer group | 每个 test/worker 使用唯一 namespace prefix，并在结束时只删除自己的 prefix |
| 外部 HTTP、ACP、MCP | fake server、请求记录、端口 | 每个 test 创建独立 fake client/server；显式关闭，不使用全局 mock |

`afterEach` 清理共享数据库、共享目录或共享 Redis key 不是并发隔离方案：测试 A 的清理可能删除测试 B 正在使用的数据。必须先通过 database/schema、目录或 key prefix 进行命名空间隔离，再做本 namespace 的清理。

#### C. 渐进迁移顺序与强制规则

1. 每个资源切片迁移前，盘点其测试使用的全局单例、`set*ForTest()`、`mock.module()`、共享 env/目录/数据库记录和未关闭 handle。
2. 先在 `src/test-utils/` 建立该切片的 `create<Module>Fixture()` 或 `createTestApp()`；fixture 创建独立依赖图、唯一外部 namespace 和 cleanup，不改业务公开 API。
3. 将该切片的测试迁至 fixture；移除对应业务代码中的 test setter、模块级可变 resolver 和全局回调。现有 `setTestAuth()`、`setTestOrgContext()` 等历史 helper 不得用于新测试，迁移到的切片必须删除对它们的依赖。
4. 对包含 DB、文件、Redis/YJS 的测试，在 CI 开启文件级并行运行；同一测试只有在明确验证并发语义时才使用并发执行 API。
5. 为测试基础设施增加守护检查：禁止新增 `set*ForTest` 导出、禁止业务测试使用 `mock.module()`、禁止测试写入默认生产目录、检测未关闭 server/connection。
6. 每个迁移完成的资源在重复并行运行后必须稳定通过；不稳定时修复共享状态，不得通过扩大 timeout、增加 retry 或把整组测试标为串行来规避。

AgentConfig 能力簇是首个试点：其 runtime credential resolver、LaunchSpec builder、授权上下文、数据库绑定、Skill 文件目录和 Environment 实例应按本节完成隔离。后续资源复用这套 fixture 与 namespace 约定，而不是再次创造全局测试开关。
