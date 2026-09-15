# CE / EE 目标架构与开发规范（待评审）

> 本文是目标架构与开发规范，供包的适配分析和实施引用。只描述未来规范，不定义物理迁移任务、实施顺序或阶段验收；目录结构与文件归属另见[目录设计](./ce-ee-engineering-directory-structure.md)。

## 1. 目标与基本决策

目标是在两个仓库中以较小团队成本交付商业版，并允许后续为多个甲方静态定制：

1. CE 不含 EE 或甲方业务代码；EE 用 Git submodule 固定引用 CE。
2. 身份、租户和授权允许整套替换，不继承 CE 角色模型。
3. 资源基础 CRUD 尽量复用；发布、审批、客户字段和流程由 EE/甲方模块扩展。
4. Agent 引擎、RAG、MCP、Sandbox、部署目标等天然多实现能力使用静态插件点；当前不把资源、权限和控制台整体做成动态插件。
5. **当前阶段**每个模块以 manifest 自描述；构建期扫描可信 workspace（EE 还扫描固定 CE submodule）并生成静态 registry。应用在启动/部署时读取 assembly 配置，选择 registry 中已注册的模块组合，不实现运行时扫描、下载或热加载业务模块。未来若成本、隔离、签名校验、生命周期管理和运维能力成熟，可另行评审并引入动态插件；该决定不应被本文永久锁死。
6. **版本命名**：基础实现使用中性目录和 `@fenix/*` package scope，不以 CE 或 Community 标识自身；EE 的替换或扩展实现使用 `@fenix-ee/*`。CE/EE 仅用于仓库、发布物和装配关系的产品线描述，不进入基础源码、包名或领域命名。

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

## 2. 模块交付物、依赖与静态装配

每个资源模块不是一个裸 service，而是一组同生命周期交付物：

```text
ResourceModule = domain + services + repositories/adapters + schemas
               + migration + route contribution
               + web contribution + capability declaration + tests + README
```

资源包的物理子目录见[目录设计](./ce-ee-engineering-directory-structure.md)。`web/` 与 `src/` 物理就近，但通过 package subpath export 和依赖规则隔离：根入口只导出后端能力，`@fenix/agent-config/web` 才导出浏览器能力。

一个模块只在第二个真实用例出现后再抽象额外 SDK；单一客户需求先在其 EE/客户模块内实现。

### 2.1 跨包引用与公开 API

跨 package 只能使用包名和 `package.json#exports` 声明的公开入口，例如 `@fenix/agent-runtime`、`@fenix/core`、`@fenix/chat-channel/server`、`@fenix/agent-config/web`、`@fenix-ee/agent-config`。禁止跨包相对导入任何 `packages/**/src/**` 路径；相对导入仅允许在同一 package 内部使用。

每个 package 必须显式声明其 workspace dependency，避免依赖被根 workspace 的偶然提升掩盖。EE 通过 `upstream/fenix` submodule 加入同一个 package-manager workspace，并从 `@fenix/*` 公开入口导入；不得因为物理目录相邻而导入 `upstream/fenix/packages/**/src/**`。`apps` 同样遵守该规则。

### 2.2 资源模块之间的依赖规则

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
import { McpService } from "@fenix/mcp";
import { SkillService } from "@fenix/skill";

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

这里的 `SkillService`、`McpService` 必须由各自 package 的根入口显式导出；调用方不得导入 `@fenix/skill/src/services/*`、B 的 repository 或 db/schema。具体 service 在 `apps/server` 装配时创建并注入，不能由资源 A 自行构造 B 的 repository 或具体授权实现。`Domain Service` 不接受 actor、不执行用户授权；资源 A 的 Facade 已授权自身动作后，可直接复用 B 的 Domain Service。资源 A 不能读取资源 B 的角色、归属或可见性规则，也不能依赖其具体授权实现。

前端遵循同样的宽松规则：关系紧密且稳定时，一个资源的 `web` 子路径可直接依赖另一资源 `web` 根入口公开的 API client、query hook、DTO 或可复用组件；禁止导入对方 `web/src/**` 内部文件，也不强制额外抽象接口。前端仅用于展示和选择，后端保存关联时必须再次校验引用资源的当前权限和有效性；EE 替换资源时，静态依赖对应 EE 资源的 `web` 入口，不做运行时前端模块覆盖或发现。

只有出现以下任一条件时，才在包根入口导出最小公开接口：需要在 CE/EE/甲方版替换实现、同一能力存在多个实现、调用方只需一个极小能力且不希望稳定整个 service API、或直接依赖会产生循环。该接口只暴露调用方完成自身规则所需的数据和动作，例如：

```ts
// @fenix/skill（包根入口公开导出）
export interface SkillReferenceResolver {
  resolveUsableSkills(input: {
    actorId: string;
    skillIds: readonly string[];
  }): Promise<readonly ResolvedSkill>;
}
```

调用方资源只依赖此接口；具体 `SkillService` 在 `apps/server` 装配时作为实现注入。

`agent-config` 与 Agent 运行链路是目标依赖设计的例子：AgentConfig 的 `use` 授权最终属于资源层；`@fenix/agent-runtime` 的 Instance/Runtime 最终不解释 actor 或权限。具体当前调用链的迁移与治理步骤属于各阶段执行计划，不在本规范规定。

### 2.3 包类别依赖矩阵

包之间的编译依赖必须从上层组合、具体实现流向稳定契约；`apps` 是唯一允许同时依赖各业务包的 composition root。下表中的“公开入口”均指 package `exports`，不允许穿透到另一个包的 `src/**`。

| 包类别 | 可以依赖 | 禁止依赖 | 说明 |
| --- | --- | --- | --- |
| `packages/platform/platform-sdk` | 语言标准库和无业务语义的基础依赖 | `platform` 具体实现、`agent-runtime`、`resources`、`apps`、任何 EE 包 | 最底层契约：资源范围、授权端口、装配 profile、模块 manifest 等 |
| `packages/platform/*` 具体实现 | `platform-sdk`、无业务语义基础依赖 | `agent-runtime`、`resources`、`apps`；CE 包禁止 EE 包 | 例如 CE/EE AccessControl；实现 SDK 的端口，但不承载资源规则 |
| `packages/core`、`packages/orchestration`、`packages/chat-channel`、`packages/remote-runtime` | 各自 manifest 声明的基础依赖 | `agent-runtime`、`resources`、具体 AccessControl、`apps` | 保持既有独立能力边界，不因上层在线链路高耦合而物理合并 |
| `packages/agent-runtime`（`@fenix/agent-runtime`） | `platform-sdk`、四个基础运行包、无业务语义基础依赖 | `resources`、具体 AccessControl、`apps` | 目标是只组合 Environment、Instance、生命周期、并发与 relay/session；其他领域经公开端口接入，具体切换由执行计划确定 |
| `packages/resources/<resource>` | `platform-sdk`、本资源声明的基础依赖、其他资源包根入口公开的 service/DTO；按需依赖根入口公开接口 | `apps`、具体 AccessControl、其他资源的内部 `src/**`、repository/schema | 资源的授权只依赖 `AccessControlModule` 契约；资源间规则见上一节 |
| `packages/resources/<resource>/web` | 本资源及其他资源 `./web` 公开的 DTO/API client/hook/组件、共享 UI、Web SDK | 所有服务端 `services`、`repositories`、db、adapter；其他资源 `web/src/**`；`apps/web` 内部 | 浏览器边界，不得把 server 代码带入 bundle |
| `apps/server` | 所有已启用包的公开入口 | 任意包内部路径 | 唯一的 server 装配根：读取 profile、注入依赖、挂载 route、注册生命周期 |
| `apps/web` | 资源 `./web` 公开入口、Web 契约、版本自己的 Shell | 服务端实现、resource 根入口中的 server-only 导出 | 最终 Web 装配根；Shell 属于 app，不属于资源包 |
| EE package / app | CE submodule 的公开 `@fenix/*` 入口、EE 自身公开入口 | CE 内部路径；CE 反向依赖 | 依赖方向只能是 `EE → CE`，以便 CE 独立构建与发布 |

推荐的总体方向如下：

```text
                         apps/server · apps/web
                                  ↓
       platform 具体实现 · resources · agent-runtime
                     ↓              ↓        ↓
             platform-sdk     core · orchestration · chat-channel · remote-runtime

EE packages/apps ─────────────────────────→ CE public packages
CE packages/apps ─────────────────────────╳ EE packages/apps
```

`fenix.module.ts` 的 `dependsOn` 是**装配依赖**，表示一个 manifest 被 profile 启用时需要同时启用哪些模块；它不能取代 TypeScript 的 `package.json` dependency，也不能放宽上述编译依赖规则。反过来，两个包存在 TypeScript 依赖也不必然意味着它们必须在每个 assembly profile 中同时启用：是否需要共同启用取决于其公开能力是否在该 profile 中被实际装配。

### 2.4 配置驱动的静态装配

配置文件用于在**已编译进当前镜像/bundle**的模块中选择组合，例如 `deploy/assembly/ee.json`：

```json
{
  "accessControl": "ee",
  "agentRuntime": "agent-runtime",
  "webShell": "default",
  "resources": ["agent-config", "agent-config-publication"],
  "web": ["agent-config"]
}
```

CE 的 `platform-sdk/assembly` 提供唯一的 `AssemblyProfile` 与 `parseAssemblyProfile()`：它只校验授权、Agent Runtime、Shell、资源和 Web 模块 ID 列表的通用结构，不知道 CE/EE 的具体 ID。CE、EE 各自只加载自己的 profile JSON/YAML；随后由对应 app 对生成 registry 做 ID、类别和依赖校验，不复制 parser，也不将 EE 字段加入基础契约。

每个可装配包在根目录导出 `fenix.module.ts`，声明稳定 `id`、`kind`、`dependsOn`、资源 module、基础模块工厂及可选 web contribution。构建脚本扫描受版本控制的 `packages/**/fenix.module.ts`；EE 同时扫描固定 submodule 的 `upstream/fenix/packages/**/fenix.module.ts`，生成仅含静态 `import` 的 `apps/generated/module-registry.ts`。app 不手写注册表。

启动流程依次执行：读取 JSON/YAML → 校验结构和重复 ID → 从**生成 registry**确认 ID 和类别 → 校验 manifest 依赖、capability 冲突、所需 env 与 migration preflight → 创建依赖并挂载 route/web contribution。profile 可随镜像交付，也可作为受部署平台保护的只读挂载文件在启动时读取；其位置由发布脚本固定，不能由 profile 自己指定。配置中禁止出现任意文件路径、URL、npm 包名、表达式或代码片段；它不能 import、下载或执行新代码。

因此，已有模块的启停、替换和组合可以只改装配配置；新增模块只需提供 package、manifest 和 assembly ID，再运行 registry 生成脚本，**不需修改 app 注册逻辑**。改变模块实现或 manifest 契约仍必须提交代码，并走正常构建、迁移及发布验证。server 与 web 可读取同一 profile 的不同区段，但 web 只消费已进入浏览器 bundle 的 contribution，绝不从配置加载远程脚本。

## 3. 后端路由与服务组织

### 3.1 路由按“协议 + 领域贡献”组织

`apps/server/src/routes` 只保留协议聚合器：

```text
apps/server/src/
├── bootstrap.ts                    # 创建依赖、装配模块、注册关闭钩子
├── routes/
│   ├── web.ts                      # 挂载所有 /web 模块贡献
│   ├── api.ts                      # 挂载已发布的 /api 外部协议 adapter
│   └── protocols.ts                # ACP、MCP、Webhook、SSE、WS 等协议贡献
└── index.ts                        # 进程入口
```

领域路由随模块存在，例如 `createAgentConfigWebRoutes({ facade, logger })`。route 负责协议校验、认证上下文提取、DTO 转换、调用 service、错误映射和接口元数据；不直接访问 db，不写跨表事务，不调用别的 route。

路由前缀规则：

| 前缀 | 消费者 | 规则 |
| --- | --- | --- |
| `/web/*` | CE 官方 Web 与可同步升级的第一方内部调用方 | 第一方控制面；可随 server/web 同步升级，不作为公开 OpenAPI 合同 |
| `/api/*` | 外部程序、SDK 与 OpenAI-compatible 客户端 | 已发布的稳定协议面；只做认证、DTO 和错误映射，并调用与 `/web` 相同的 Resource Facade |
| `/acp/*`、`/mcp/*`、`/hooks/*`、WS/SSE | 协议/内部桥接 | 独立协议契约，不作为第二套资源业务 API |

非 CRUD 动作使用资源动作后缀，如 `POST /web/agent-configs/:id/run`、`POST /web/agent-configs/:id/publish`。动作始终进入资源 services 层，再经端口调用 runtime。

本阶段不在资源模块新增或扩展 `/api/*` 外部 API。`/web/*` 允许 session、服务账号或受控内部 API Key 等认证方式，但只有 CE 官方 Web 和可同步升级的内部调用方可以依赖其契约；第三方、用户脚本和 SDK 必须使用版本化的 `/api/*`。当前已经发布的 `/api/agents` CRUD、Instance connect 与 OpenAI-compatible endpoint 属于外部合同，按 ARC-03 冻结规则保留为调用同一 Facade 的薄协议 adapter，不是第二套业务实现；其变更或退役必须经独立 ADR、消费者盘点和迁移窗口，资源模块不得复制这些 route。

### 3.2 服务与 repository

默认依赖方向：`routes → Resource Facade → Domain Service / repositories / adapters`。Facade 是外部资源操作入口，负责 actor 授权、状态校验、跨资源编排、事务、幂等性和外部调用；Domain Service 只处理资源自身领域规则与数据访问，不接受 actor，也不做用户权限校验；repositories 只封装存储查询和事务原语；adapters 只处理外部协议或 Provider 差异，不能承载领域规则。

资源之间可直接引用对方包根入口公开的无权限 Domain Service；授权由发起动作的 Resource Facade 统一完成，不在同一次编排中重复校验被依赖资源的用户权限。

全局系统管理员仍是带真实 `userId` 的用户 actor，由 `AccessControlModule` 根据系统管理员身份放行系统级动作，以保留审计主体。迁移、运维和模块内部调用不构造 actor，直接使用受信任的 Domain Service；当前不定义 `system` actor。

普通用户的资源列表必须通过 `AccessControlModule` 及统一授权查询能力，将声明式查询约束下推为数据库条件；系统管理 Facade 在完成系统管理员校验后、以及受信任模块内部调用可复用无权限 Domain Service 的列表查询。禁止 service 先读全量数据再按组织、角色或版本过滤；Repository 不得自行读取 member/role、资源归属列或 `visibility`，更不得复制授权 SQL。

### 3.3 授权范围与资源查询约束

基础版本的可授权资源主表复用现有 `organization_id`、`user_id` 和 `visibility` 作为 `ResourceScope` 的真相来源，由 `ResourceScopeStore` 映射主表列。通用资源可选 `private` 或 `public`；`private` 沿用归属和成员角色规则，`public` 面向任意已认证用户。匿名访问由 Site 等资源专属发布字段或发布实体表达。资源领域、route、前端和普通 Repository 不得自行解释组织、用户、角色或 `visibility`；EE 可以扩展自己的 scope 与授权存储实现。

`AccessControlModule` 负责回答“当前主体可以看哪些资源范围”和“是否允许操作单个资源”；`ResourceScopeStore` 负责 organization、owner、`visibility` 的批量读取、校验与生命周期维护；统一授权查询能力将访问约束编译为当前存储方案所需的 Drizzle 条件。资源 Repository 只声明资源类型、ID、组织、owner 与 `visibility` 列及业务条件，例如 `authorizedQuery.list({ resourceType, columns, businessWhere, access })`，不编写 member/role 判断或授权 SQL。Service 返回 `ResourceRecord<TData, TScope>`，CE 返回 `ResourceScope`，EE 则返回其扩展的 scope；不得泄漏具体查询条件。

当前授权查询以资源主表为驱动，使用归属列、`visibility` 与成员角色策略过滤资源；不得先查询全量资源再在应用层过滤。完整接口和迁移边界见 [CE 用户、组织与资源权限模型设计](./ce-access-control-design.md)。

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
├── api/                    # 调用 /web 的类型化客户端
├── pages/                  # 领域页面与容器
├── components/             # 领域组件
├── hooks/                  # 本领域数据和状态逻辑
├── i18n/                   # 本领域翻译资源
└── contribution.ts         # 导航、权限提示、页面元数据、路由目标声明
```

TanStack Router 仍保持文件路由：应用的 `routes/` 是薄文件，静态导入选定资源模块 `web/` 子路径的页面。不要尝试运行时注入路由；EE 添加页面时在 EE web app 建立 route adapter，或由 EE 资源模块的 `web/` 提供页面，再由 app 显式注册。

`WebShell` 是版本级产品组合，不是资源模块，也不放入 `packages`。基础实现的 `apps/web/src/shell/DefaultAppShell.tsx` 持有首页、布局、导航和全局 Provider；EE 若有整体差异，则在自己的 `apps/web/src/shell/EeAppShell.tsx` 持有企业首页、SSO 初始化、企业导航和布局。EE Shell 不继承、也不通过覆盖基础 Shell 的局部 hook 实现差异。

assembly 的 `webShell` 显式选择当前 app 自己提供的唯一最终壳，`web` 列表则选择构建期生成 registry 中的资源页面 contribution：

```text
assembly.webShell → apps/web 的 DefaultAppShell 或 EeAppShell
assembly.web      → generated module registry → resources/*/web contribution
```

因此，资源页不能反向决定全局布局；Shell 可收集已启用资源模块的导航、路由和页面 contribution，但不得导入资源模块的 server service、repository 或 db。若将来确实有两个以上独立 Web 应用复用同一完整 Shell，才把已稳定的 Shell 实现抽取为 package；即使如此，`apps/web` 仍是最终选择和装配入口。

### 4.2 前端差异化规则

“复用领域服务，EE 扩展流程”在前端同样成立，但前后端扩展独立：

1. **无 UI 差异**：EE 复用 CE `resources/agent-config/web` 页面和 API client。
2. **局部差异**：EE 复用 CE API client、DTO、通用表格/表单组件，在 `resources/agent-config/web` 追加发布按钮、状态展示或审批页；不复制整个 CE 页面。
3. **页面流程整体不同**：EE 在自己的资源模块 `web/` 提供替代页面，并在 EE app 的静态 route adapter 中选择它；后端仍可复用 CE domain/repository。
4. **甲方品牌与导航差异**：由 `apps/web` Shell 的静态品牌/导航配置处理，不侵入资源模块。
5. **首页、布局或全局交互模型整体不同**：在 EE/甲方自己的 `apps/web/src/shell` 实现完整 Shell，并以 assembly 的 `webShell` 选择；资源模块的 API client、DTO 和页面仍可按实际差异复用。

前端只能通过 API client 取数，必须覆盖 loading、empty、error、retry、无权限和成功反馈；用户可见字符串进入模块 i18n。前端的“可见/不可见”仅是体验，服务端 services 授权才是安全边界。

## 5. 环境变量与配置

### 5.1 单一启动校验与模块声明

环境变量对一个 server 进程只有一份：启动时统一读取、统一校验一次。业务模块**不自行读取** `process.env`，也不各自加载 `.env` 文件；它只声明自己确实需要的部署级配置，并由 `apps/server` 将已校验的配置注入构造函数。

绝大多数资源模块不需要 env。例如 AgentConfig 的名称、模型、Skill、发布状态是数据库业务配置，不是环境变量。只有数据库连接、对象存储、模型网关、Sandbox 地址、第三方密钥等“部署时确定、重启后才变化”的配置才声明 env。

```ts
// packages/agent-runtime/fenix.module.ts
// 下例仅说明模块如何声明并消费环境变量，不要求额外 adapter 模块。
export const moduleManifest = {
  id: "agent-runtime",
  kind: "agent-runtime",
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

`bootstrap.ts` 不直接 import 或调用具体模块工厂，例如 Agent runtime、PostgreSQL client 或对象存储 client。它只解析 assembly、取得已启用 manifest、统一读取/校验 env，并将按模块切分后的配置交给装配器/模块工厂。本节最小示例只说明 schema 与 migration 的组织方式，不模拟数据库连接或 PostgreSQL 模块；真实工程接入数据库时，由负责存储的模块声明连接配置并接收注入，repository 只接收已构造的 db client，不读取连接串。

`envDefinition` 至少声明字段名、Zod schema、默认值、是否 secret、是否 restart-required、所属模块和用途说明。加载器合并所有静态装配模块的声明；同名字段的 schema、默认值或 secret 属性不一致时启动失败，EE 只能追加自己的定义，不能静默改变 CE 同名变量语义。

```text
CE server env = server host env + CE profile 启用模块的 env
EE server env = server host env + EE profile 启用的 CE/EE 模块 env
```

前端 `apps/web` 不读取 server env，也永远拿不到 secret。它的少量公开构建配置（例如公开服务地址、构建版本、品牌默认值）由独立的 `webEnv` 声明并在构建时注入；更适合运行时变化的品牌、导航和功能开关则从受控的 `/web` 配置接口读取。

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

CE、EE 的 migration journal 必须相互隔离，避免两个仓库争用迁移记录；EE 对 CE 表的依赖以 submodule 固定提交为准。具体部署升级顺序由 EE 发布实施计划确定。

### 6.2 EE 新增表的归属

EE 不得用 migration 修改 CE 拥有的表。若商业需求必须改变 CE 表结构，应先在 CE 增加通用字段/扩展点并发布，再升级 EE submodule；若是 EE 专属数据，使用 EE 扩展表，以 `agent_config_id` 等稳定 ID 关联 CE 表。

### 6.3 迁移规则

1. 变更模块 schema，更新模块 schema manifest。
2. 通过仓库的 `db:generate --name <module>-<change>` 生成当前仓库 migration。
3. 审查 SQL、snapshot、journal；DDL 仅处理结构。
4. 有存量数据时，新增独立、幂等、可观测的数据迁移；记录完成标识与批次进度。
5. CI 对空库和升级库都执行 migration smoke test；生产先备份并执行 migration preflight。

已经被正式环境消费的 migration 不可改写；现存版本如何搬移、发布与回滚由对应执行计划规定。

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

当前 CE 只使用 PostgreSQL + Drizzle。Repository 直接使用由 server 创建的 Drizzle db，migration runner 使用专用的 Drizzle migration client；本阶段不预先定义通用数据库抽象或 `databaseType` 分支。只有在第二种关系型数据库、独立迁移连接或明确的跨数据库运行需求出现后，才针对真实用例设计窄的 repository/transaction/migration port。

先区分两种情况：

| 场景 | 推荐方案 |
| --- | --- |
| 文件、Skill 包、附件、日志归档、向量库等领域存储替换 | 在对应资源/Provider 端口新增 adapter；关系型元数据保持不变；静态装配选择 adapter |
| 关系型主库从 PostgreSQL 改到其他 DB | 这是基础设施替换，不是替换 Drizzle driver；为所有 repository port 提供新 adapter、事务实现、索引/约束方案和迁移工具 |

新 DB 必须正确编译第 3.3 节的授权查询约束，并通过同一 repository contract test suite；同时提供全量迁移、双环境校验、备份和回滚方案后才能切换。

不允许为了“支持多 DB”在 domain/services 中加入 `if (databaseType)`；也不在没有第二种实际实现前提前抽象所有 Drizzle 细节。

## 7. 结构化日志与请求关联

当前诊断仅复用 `@fenix/logger`：它输出结构化日志，并通过 `requestAls` 自动注入 `requestId`、用户和组织上下文。HTTP 请求由 `src/plugins/logger.ts` 在入口生成 `requestId`，写入 ALS，并通过 `X-Request-Id` 返回给调用方；不新增 `platform/observability`、`Logger`、`AuditRecorder`、`Metrics` 或 `Tracer` 抽象。

异步任务、实例、队列和 relay 若由 HTTP 请求触发，必须在其显式输入与诊断日志中保留触发方的 `requestId`；独立调度或启动流程在自身入口建立新的关联 ID。services 记录关键状态转换，adapters 记录重试、超时和外部依赖失败，且不在每层重复记录同一错误。控制台系统日志页只读取经过权限过滤的日志投影，不得直接暴露底层日志文件。

日志不得记录 token、Cookie、密码、连接串、完整 prompt/文件内容和未脱敏外部响应。审计、指标和分布式 tracing 不是当前平台能力；出现真实产品或运维需求时，另立设计与任务，不预设跨版本端口。

## 8. 部署、构建和运行脚本

`scripts/` 只做薄编排，不承载业务逻辑：

| 脚本 | 职责 |
| --- | --- |
| `check-module-boundaries` | 检查禁止依赖、公开入口与 submodule 未修改 |
| `build-release` | 构建 server/console、生成版本与 SBOM 信息 |
| `migrate-fenix` / `migrate-ee` | 分别运行带独立 journal 的 DDL 迁移 |
| `run-data-migrations` | 执行已登记且幂等的数据迁移 |
| `deploy-preflight` | 校验 env、DB 连通性、迁移状态、镜像版本和依赖服务 |
| `release` | 串联 preflight、迁移、部署、readiness、回滚判断 |

`deploy/compose` 使用“基础编排 + 可选 profile/overlay”：主服务、数据库、模型网关、知识库、Sandbox 等可独立启停。模块声明其依赖服务与健康检查；部署入口根据静态装配的模块生成/选择 profile，而不是由业务代码自行启动 Docker。

CE/EE 各自的部署、升级与回滚步骤由其执行计划负责，本节仅规定通用构建及部署职责。

## 9. Git submodule 版本依赖边界

EE 根 `package.json` 将 `upstream/fenix/packages/*/*` 纳入 workspace，EE 代码仅从 CE 包公开入口导入。CE 的公开包遵循语义化兼容承诺，并在每个 release tag 产出：变更日志、兼容性说明、migration manifest、环境变量变化和废弃项。

EE 对 CE 的引用必须固定为经过审查的不可变 tag/commit，不得修改 submodule 中的 CE 代码。具体升级步骤、校验命令和回滚流程由 EE 的升级实施计划承担，不由本设计文档规定。

## 10. 扩展方案决策表

| 需求 | 放置与做法 | 禁止做法 |
| --- | --- | --- |
| 替换身份、租户、权限 | 在 platform 实现 `AccessControlModule`，app 静态替换 | 在资源 service 中读取 CE member/role 表 |
| `AccessControlModule` 缺能力 | 见 10.1 | 给现有接口塞客户专属 optional 字段或 `as any` |
| EE 对资源增加发布/审批/版本 | EE resources 包：自有 schema、状态机、Facade 覆盖/组合、route/web contribution；参考 §10.2 | 修改 CE 资源表加入 EE 字段，或复制 CE CRUD |
| 前端局部/整体差异 | EE 资源模块的 `web/` 复用 API client/组件或替换页面，在 app 静态选择 | fork 整个 CE web app、运行时注入路由 |
| 新增从未有过的业务功能 | 新建 EE resource/agent-runtime/web 模块，声明依赖、schema、routes、UI、测试 | 将功能塞进 platform-sdk 或 app.ts |
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
// packages/resources/agent-config/src/services/approval-policy.ts
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

### 10.2 EE Resource 的 Version / Tag 问题

EE 需要对某些资源（如智能体）进行发布管理，会产生新的 Version/TAG。此时：

1. CE 公共 Facade 与跨资源关联只使用唯一、不可变的资源 ID；EE 为资源增加版本时，每个可引用版本拥有独立 ID，tag 或 version 只是 EE 模块内部指向该 ID 的别名，不得将 tag、version 或通用 params 加入 CE 公共接口。
2. 基础 list 仍列出具体资源记录，相当于列出所有版本对象；按逻辑资源聚合、列出 tag、解析 tag 等能力由 EE 资源模块扩展。
3. AgentConfig 等引用者只保存依赖版本的确定 ID；版本内容变化必须产生新 ID，禁止在原 ID 下覆盖已被引用的内容。

## 11. 对现有工程切面的覆盖

以下是目标架构对现有功能分类的归属映射；本节仅定义长期职责，不规定功能拆迁顺序。

| 当前功能分类 | 目标落位/扩展模型 |
| --- | --- |
| 身份、组织、API Key、资源权限 | platform identity/tenancy/access-control；可整体替换 |
| Agent 配置、Skill、MCP、模型、知识库、站点 | resources；基础 CRUD + 各自 domain/services；模型域由单一 `@fenix/model` 承载 Provider 聚合根与严格继承其权限的 Model 二级资源 |
| Environment、Instance、Runtime、relay、ACP session、Chat、YJS | `@fenix/agent-runtime` 统一组合原 `src` 运行编排；基础实现继续归属 `@fenix/core`、`@fenix/orchestration`、`@fenix/chat-channel`、`@fenix/remote-runtime` |
| 文件、机器、Sandbox | 资源或 transport adapter；通过公开 port 接入 `@fenix/agent-runtime`，不反向侵入 Agent 内部实现 |
| 工作流、任务、Webhook、调度 | 独立资源或编排模块；通过 Agent 公开 port 接入，节点、执行器、触发器为静态插件 |
| 控制台壳、导航、业务页面、品牌 | apps/web 壳 + resources 模块内的 `web/`；静态 contribution |
| 应用 HTTP、MCP/ACP/Webhook/SSE/WS | 模块 server route contribution + app 协议聚合 |
| DB、数据迁移、日志、部署、系统管理 | 仓库级 `db/`、`deploy/`、`@fenix/logger` 与应用日志入口；模块显式贡献 |

因此，当前已知切面均有归属：领域差异走 resources/console，身份差异走 platform，Agent 运行能力走单一 `@fenix/agent-runtime`，执行 adapter/provider 走对应模块，交付与治理走 apps/db/deploy/docs。每个功能的具体改动范围、发布与兼容策略由执行计划核定。
