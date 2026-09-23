# CE 目标架构与开发规范（待评审）

> 本文定义目标架构与开发规范；目录结构与文件归属另见[目录设计](./ce-ee-engineering-directory-structure.md)。

## 1. 目标与基本决策

目标是建立清晰、可维护的 CE 工程架构：

1. 身份、租户和授权是独立的平台模块，不与资源领域逻辑混杂。
2. 资源基础 CRUD、发布状态和业务流程由资源模块各自维护。
3. Agent 引擎、RAG、MCP、Sandbox、部署目标等天然多实现能力使用静态插件点；不把资源、权限和控制台整体做成动态插件。
4. 每个模块以 manifest 自描述；构建期扫描可信 workspace 并生成静态 registry。应用在启动/部署时读取 assembly 配置，选择 registry 中已注册的模块组合，不实现运行时扫描、下载或热加载业务模块。
5. 基础实现使用中性目录和 `@fenix/*` package scope，不以 CE 或 Community 标识自身。

### 1.1 不采用纯插件架构

纯插件架构要求每个模块分别实现权限、资源配置、路由和页面插件，面对身份与资源流程大幅分叉时会形成多套平行实现。本文采用：**稳定 SDK 契约 + 领域模块复用 + 配置驱动的静态装配 + 局部静态插件**。

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

一个模块只在第二个真实用例出现后再抽象额外 SDK。

### 2.1 跨包引用与公开 API

跨 package 只能使用包名和 `package.json#exports` 声明的公开入口，例如 `@fenix/agent-runtime`、`@fenix/core`、`@fenix/chat-channel/server`、`@fenix/agent-config/web`。禁止跨包相对导入任何 `packages/**/src/**` 路径；相对导入仅允许在同一 package 内部使用。

每个 package 必须显式声明其 workspace dependency，避免依赖被根 workspace 的偶然提升掩盖。`apps` 同样遵守该规则。只在构建或测试中使用的 workspace 依赖声明在 `devDependencies`，`dependencies` 保留给运行时需要被消费者解析的依赖。

资源包 `web/` 交付物的第三方（非 workspace）依赖同样必须显式声明，按“是否需要与宿主共用同一实例”分为三类；判定依据只能是包内**实际导入**，只出现在注释或文档里的引用不算使用：

1. 需要与宿主共用同一实例的框架库——`react`、`react-dom`、`react-i18next`、`i18next`、`@tanstack/react-router`——凡该包 `web/` 实际导入即声明为 `peerDependencies`，版本范围与根 `package.json` 逐字一致。写进 `dependencies` 会打进第二份实例：第二份 React 的 context/hooks、第二份 i18next 的命名空间注册表都会让组件静默取到空值或回退成 key 回显。
2. 可独立打进浏览器 bundle、重复实例不影响语义的普通库（`lucide-react`、`ahooks`、`sonner` 等）声明为 `dependencies`，版本对齐根 `package.json`。
3. 只在测试文件中导入的库（含 `happy-dom` 等 DOM 环境）声明为 `devDependencies`；写进 `dependencies` 会把测试依赖带进宿主的生产依赖图与发布物。

反向同样成立：`dependencies` 里没有任何导入的条目必须删除，删除前逐条 grep 全包确认，避免声明与真实加载图长期漂移。

§2.4 中由生成 registry 引入的 `apps/*/fenix.module.ts` 是上述相对导入禁令的唯一例外：它是构建期装配描述符，不作为可安装入口对外暴露。

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

这里的 `SkillService`、`McpService` 必须由各自 package 的根入口显式导出；调用方不得导入 `@fenix/skill/src/services/*`、B 的 repository 或 db/schema。具体 service 在 `apps/server` 装配时创建并注入，不能由资源 A 自行构造 B 的 repository 或具体授权实现。**调用期**的 `db/schema` 禁则不含 schema 组装期的跨模块外键表对象引用——那是 §6.1 单独规定的路径作用域例外，只在 `db/**` 内成立。`Domain Service` 不接受 actor、不执行用户授权；资源 A 的 Facade 已授权自身动作后，可直接复用 B 的 Domain Service。资源 A 不能读取资源 B 的角色、归属或可见性规则，也不能依赖其具体授权实现。

前端遵循同样的宽松规则：关系紧密且稳定时，一个资源的 `web` 子路径可直接依赖另一资源 `web` 根入口公开的 API client、query hook、DTO 或可复用组件；禁止导入对方 `web/src/**` 内部文件，也不强制额外抽象接口。前端仅用于展示和选择，后端保存关联时必须再次校验引用资源的当前权限和有效性。

只有出现以下任一条件时，才在包根入口导出最小公开接口：同一能力存在多个实现、调用方只需一个极小能力且不希望稳定整个 service API、或直接依赖会产生循环。该接口只暴露调用方完成自身规则所需的数据和动作，例如：

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

`agent-config` 与 Agent 运行链路是目标依赖设计的例子：AgentConfig 的 `use` 授权最终属于资源层；`@fenix/agent-runtime` 的 Instance/Runtime 最终不解释 actor 或权限。

### 2.3 包类别依赖矩阵

服务模块之间默认从上层组合、具体实现流向稳定契约；`apps` 是最终 composition root。平台组合和 Runtime 基础资源存在下表明确列出的有界直接依赖，但不得据此放宽为 `platform/*` 或 `agent-runtime` 可任意依赖 `resources/*`。下表中的“公开入口”均指 package `exports`，不允许穿透到另一个包的 `src/**`。

| 包类别 | 可以依赖 | 禁止依赖 | 说明 |
| --- | --- | --- | --- |
| `packages/platform/platform-sdk` | 语言标准库和无业务语义的基础依赖 | `platform` 具体实现、`agent-runtime`、`resources`、`apps` | 最底层契约：资源范围、授权端口、身份目录投影、系统管理协议 schema、装配 profile、模块 manifest、应用基础设施访问规则等；不创建或拥有 DB 等具体基础设施 |
| `packages/platform/identity` | `platform-sdk`、认证/存储等必要基础依赖 | `access-control`、`agent-runtime`、`resources`、`apps` | 有状态平台模块，拥有用户、组织、成员、认证/API Key 及其 DB、route、Web；产出可信身份上下文和公开 Identity Service |
| `packages/platform/access-control` | `platform-sdk`、同一产品版本的 `identity` 公开入口、无业务语义基础依赖 | `agent-runtime`、`resources`、`apps`、Identity 的内部路径 | Identity 与 AccessControl 保持两个包，普通资源不得依赖此具体实现 |
| `packages/` 中除 `platform/*`、`agent-runtime`、`resources/*` 外的包 | 按各包自身的 SDK 或插件职责声明 | 包间依赖环 | 独立 SDK/插件包，如 `acp-link`、`core`、`orchestration`、`chat-channel`、`remote-runtime`；服务模块直接通过包引用使用其能力，不适用服务模块依赖矩阵的其他限制 |
| `packages/agent-runtime`（`@fenix/agent-runtime`） | `platform-sdk`、四个基础运行包、Machine/Sandbox 的专用公开运行入口、无业务语义基础依赖 | 除 Machine/Sandbox 外的 `resources`、具体 AccessControl/Identity、`apps`、Machine/Sandbox 内部路径（跨模块外键的表对象引用见 §6.1） | 组合 Environment、Instance、生命周期、并发与 relay/session；固定编译方向是 `agent-runtime → sandbox → machine` 及 `agent-runtime → machine` |
| `packages/resources/machine` | `platform-sdk`、本资源声明的基础依赖 | `agent-runtime`、Sandbox、具体 AccessControl/Identity、`apps`、其他包内部路径 | Runtime 固定基础资源；拥有注册、心跳、文件与在线状态，不得回调 Runtime repository、singleton 或生命周期实现 |
| `packages/resources/sandbox` | `platform-sdk`、Machine 公开入口、Sandbox Provider 公开 API、本资源声明的基础依赖 | `agent-runtime`、具体 AccessControl/Identity、`apps`、其他包内部路径 | Runtime 固定基础资源；拥有执行环境供给、恢复和管理面，多实现差异留在 Provider 插件点 |
| 其他 `packages/resources/<resource>` | `platform-sdk`、本资源声明的基础依赖、其他资源包根入口公开的 service/DTO；按需依赖根入口公开接口 | `apps`、具体 AccessControl/Identity、其他资源的内部 `src/**`、repository/schema（跨模块外键的表对象引用见 §6.1） | 资源的授权只依赖 `AccessControlModule` 契约；需要身份的只读投影（用户展示信息、组织名录、成员关系、系统托管租户）时经 `platform-sdk` 的 `IdentityDirectory` 窄契约，由 app 装配注入；资源间规则见上一节 |
| `packages/resources/<resource>/web` | 本资源及其他资源 `./web` 公开的 DTO/API client/hook/组件、已作为公开入口发布的共享 UI、Web SDK | 所有服务端 `services`、`repositories`、db、adapter；其他资源 `web/src/**`；`apps/web` 内部 | 浏览器边界，不得把 server 代码带入 bundle。共享 UI 目前没有独立公开入口，资源 web 不得因此穿透 `apps/web` 内部；复用方式（提取公开入口或其他）单独决定 |
| `apps/server` | 所有已启用包的公开入口 | 任意包内部路径 | 唯一的 server 装配根：读取 profile、注入依赖、挂载 route、注册生命周期 |
| `apps/web` | 资源 `./web` 公开入口、Web 契约、版本自己的 Shell | 服务端实现、resource 根入口中的 server-only 导出 | 最终 Web 装配根；Shell 属于 app，不属于资源包 |

推荐的总体方向如下：

```text
                              apps/server · apps/web
                                       ↓
              resources · agent-runtime · platform 具体实现
                  ↓            ↓              ↓
             platform-sdk  sandbox       access-control
                               ↓           ↓       ↓
                            machine     identity → platform-sdk
                               ↓
                          platform-sdk

agent-runtime ──→ sandbox ──→ machine
       └────────────────────→ machine
Machine/Sandbox ─────────────────────╳ agent-runtime

```

新增反向于默认层级的直接依赖时，必须先通过以下准入规则，不能因当前实现方便而自动获得豁免：

1. Platform 需要的能力只有在它定义身份、租户、授权等平台基础语义时，才重新归类为 `packages/platform/*`；平台模块可以拥有 DB、route、Web 和 migration。若仍是普通业务资源，Platform 不得直接依赖，只能由 app 编排或通过经评审的窄端口注入。
2. Agent Runtime 只有在某资源是所有 Runtime 装配必需的运行基础能力、调用不解释 actor/role/visibility、依赖能保持无环，并且多实现差异已收敛在资源内部 Provider/adapter 时，才能直接依赖其专用公开运行入口。任一条件不满足，使用 Resource Facade、app use case 或窄端口。
3. 每条例外必须精确写入本矩阵和架构门禁，例如 `agent-runtime → sandbox`；禁止使用 `agent-runtime → resources/*` 或 `platform → resources/*` 通配规则。禁则的覆盖范围包括同一类别内部各包之间的方向（例如 `identity → access-control`），矩阵写明的方向必须能被门禁判定，不依赖人工约定。
4. 被依赖包只能暴露稳定 service/DTO 或专用 runtime-facing subpath；调用方不得导入 route、repository、schema 或 `src/**`，不得把资源授权、存储模型和管理面泄漏到 Platform/Runtime。
5. `package.json` 编译依赖、manifest `dependsOn` 和 assembly 必须表达同一方向；必需模块成套启用。新增例外必须同时更新本矩阵，并提供 dependency-cruiser/architecture check、contract test 和循环依赖测试。
6. 若能力需要替换整个模块，具体直接依赖不成立，应依赖稳定契约并由 app 装配；若只替换同一资源的 Provider/adapter，则资源包保持稳定，调用方可以依赖资源公开入口。

`fenix.module.ts` 的 `dependsOn` 是**装配依赖**，表示一个 manifest 被 profile 启用时需要同时启用哪些模块；它不能取代 TypeScript 的 `package.json` dependency，也不能放宽上述编译依赖规则。反过来，两个包存在 TypeScript 依赖也不必然意味着它们必须在每个 assembly profile 中同时启用：是否需要共同启用取决于其公开能力是否在该 profile 中被实际装配。

manifest 的 `kind` 取 `access-control`、`agent-runtime`、`identity`、`resource`、`web-shell` 之一；`capabilities` 是模块对外声明的能力标识，同一 capability 不得由两个已启用模块提供。两者都参与 profile 与 preflight 校验；需要新增类别或固定语义时先修订本节。

### 2.4 配置驱动的静态装配

配置文件用于在**已编译进当前镜像/bundle**的模块中选择组合，例如 `deploy/assembly/default.json`：

```json
{
  "identity": "identity",
  "accessControl": "access-control",
  "agentRuntime": "agent-runtime",
  "webShell": "default",
  "resources": ["agent-config"],
  "web": ["agent-config"]
}
```

`platform-sdk/assembly` 提供唯一的 `AssemblyProfile` 与 `parseAssemblyProfile()`：它只校验 Identity、授权、Agent Runtime、Shell、资源和 Web 模块 ID 列表的通用结构。Identity 与 AccessControl 由各自 manifest 的精确 `dependsOn` 成套绑定；随后 app 对生成 registry 做 ID、类别和依赖校验，不复制 parser。

`webShell` 必须指向一个 `kind` 为 `web-shell` 的已注册模块，否则装配直接失败：Shell 是 profile 描述浏览器侧组合的锚点，允许它悬空等于 profile 与 bundle 静默不一致。`identity` 在 `packages/platform/identity` 落地前为**可选**，未提供时既不校验也不进入装配顺序；Identity 包已随阶段 2 任务 1.2 交付，现为**必填**——`access-control` 经 `dependsOn` 精确绑定到 `identity`，缺任一即装配失败。Server 只校验并绑定 `webShell`，不实例化 Shell——它由 `apps/web` 自行消费，因此不进入服务端的 `modules` 与 `instances`。

每个可装配包在根目录导出 `fenix.module.ts`，声明稳定 `id`、`kind`、`dependsOn`、资源 module、基础模块工厂及可选 web contribution。构建脚本扫描受版本控制的 `packages/**/fenix.module.ts` 与 `apps/*/fenix.module.ts`，生成仅含静态 `import` 的 `apps/generated/module-registry.ts`。app 不手写注册表。

`apps/*` 下的 manifest 是本节前一段「WebShell 是应用级组合，不是资源模块」的直接结果：Shell 不在 `packages` 中，`webShell` 却必须指向一个已注册模块，因此允许应用根目录提供 manifest。两条附加约束保证它不会污染服务端 registry：该目录下的 manifest 只能是 `kind: "web-shell"`，且文件内只允许 `import type`（类型导入在运行时被擦除），不得出现值导入与 `export ... from`；生成器以相对路径引入它，不建立 `apps/server → apps/web` 的包依赖。

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

资源模块不得新增或扩展 `/api/*` 外部 API。`/web/*` 允许 session、服务账号或受控内部 API Key 等认证方式，但只有 CE 官方 Web 和可同步升级的内部调用方可以依赖其契约；第三方、用户脚本和 SDK 必须使用版本化的 `/api/*`。当前已经发布的 `/api/agents` CRUD、Instance connect 与 OpenAI-compatible endpoint 属于外部合同，保留为调用同一 Facade 的薄协议 adapter，不是第二套业务实现；其变更或退役必须经独立 ADR、消费者盘点和迁移窗口，资源模块不得复制这些 route。

### 3.2 服务与 repository

默认依赖方向：`routes → Resource Facade → Domain Service / repositories / adapters`。Facade 是外部资源操作入口，负责 actor 授权、状态校验、跨资源编排、事务、幂等性和外部调用；Domain Service 只处理资源自身领域规则与数据访问，不接受 actor，也不做用户权限校验；repositories 只封装存储查询和事务原语；adapters 只处理外部协议或 Provider 差异，不能承载领域规则。

资源之间可直接引用对方包根入口公开的无权限 Domain Service；授权由发起动作的 Resource Facade 统一完成，不在同一次编排中重复校验被依赖资源的用户权限。

全局系统管理员仍是带真实 `userId` 的用户 actor，由 `AccessControlModule` 根据系统管理员身份放行系统级动作，以保留审计主体。迁移、运维和模块内部调用不构造 actor，直接使用受信任的 Domain Service；当前不定义 `system` actor。

普通用户的资源列表必须通过 `AccessControlModule` 及统一授权查询能力，将声明式查询约束下推为数据库条件；系统管理 Facade 在完成系统管理员校验后、以及受信任模块内部调用可复用无权限 Domain Service 的列表查询。禁止 service 先读全量数据再按组织、角色或版本过滤；Repository 不得自行读取 member/role、资源归属列或 `visibility`，更不得复制授权 SQL。

### 3.3 授权范围与资源查询约束

可授权资源主表复用现有 `organization_id`、`user_id` 和 `visibility` 作为 `ResourceScope` 的真相来源，由 `ResourceScopeStore` 映射主表列。通用资源可选 `private` 或 `public`；`private` 沿用归属和成员角色规则，`public` 面向任意已认证用户。匿名访问由 Site 等资源专属发布字段或发布实体表达。资源领域、route、前端和普通 Repository 不得自行解释组织、用户、角色或 `visibility`。

`AccessControlModule` 负责回答“当前主体可以看哪些资源范围”和“是否允许操作单个资源”；`ResourceScopeStore` 负责 organization、owner、`visibility` 的批量读取、校验与生命周期维护；统一授权查询能力将访问约束编译为当前存储方案所需的 Drizzle 条件。资源 Repository 只声明资源类型、表、ID、组织、owner 与 `visibility` 列及业务条件，例如 `authorizedQuery.list({ resourceType, table, columns, businessWhere, access })`，不编写 member/role 判断或授权 SQL。Service 返回 `ResourceRecord<TData, ResourceScope>`，不得泄漏具体查询条件。

`AuthorizedResourceQuery` 是声明在 `platform-sdk` 的端口（用存储类型包参数化，默认槽位为 `unknown`，因此不导入 Drizzle），Drizzle 实现在 `access-control`；资源包只依赖端口。`ResourceQueryConstraint` 对资源模块保持不透明，其内部载荷由产出它的授权实现私有，条件编译器与动作推导在同一实现包内共享同一份策略函数。

当前授权查询以资源主表为驱动，使用归属列、`visibility` 与成员角色策略过滤资源；不得先查询全量资源再在应用层过滤。完整接口和迁移边界见 [CE 用户、组织与资源权限模型设计](./ce-access-control-design.md)。

## 4. 前端与控制台组织

### 4.1 前端分为壳和功能模块

```text
apps/web/src/
├── routes/                 # 文件路由的薄适配层；只连接页面与路由参数
├── app.tsx                 # Provider、错误边界、模块注册
└── shell/                  # 本版本最终壳：布局、首页、导航、品牌、Provider、鉴权后壳

apps/generated/
├── module-registry.ts      # 构建期生成的服务端装配 registry（各 `fenix.module.ts` 静态 import）
└── web-contributions.ts    # 构建期生成的浏览器 contribution 静态 import（只被 apps/web 消费）

packages/resources/<module>/web/
├── api/                    # 调用 /web 的类型化客户端
├── pages/                  # 领域页面与容器
├── components/             # 领域组件
├── hooks/                  # 本领域数据和状态逻辑
├── i18n/                   # 本领域翻译资源
└── contribution.ts         # 浏览器面贡献，形状由 @fenix/web-runtime 的 ./shell/contribution 定义；当前只落导航
```

TanStack Router 仍保持文件路由：应用的 `routes/` 是薄文件，静态导入选定资源模块 `web/` 子路径的页面。不要尝试运行时注入路由。

`WebShell` 是应用级组合，不是资源模块，也不放入 `packages`。`apps/web/src/shell/DefaultAppShell.tsx` 持有首页、布局、导航和全局 Provider。

`web` 列表按各模块 manifest 的 `web.contribution` 说明符选择浏览器 contribution，由独立产物静态导入：

```text
assembly.web      → apps/generated/web-contributions.ts → <pkg>/web/contribution
```

浏览器侧消费 contribution 时不得因重导出链加载服务端模块（§10.2.4）。服务端 registry 与浏览器清单是**两份产物**（`module-registry.ts` / `web-contributions.ts`）：后者只被 `apps/web` 的构建消费，不进 server registry；约束是浏览器入口的加载图里不出现服务端实现。

因此，资源页不能反向决定全局布局；Shell 可收集已启用资源模块的导航、路由和页面 contribution，但不得导入资源模块的 server service、repository 或 db。若将来确实有两个以上独立 Web 应用复用同一完整 Shell，才把已稳定的 Shell 实现抽取为 package；即使如此，`apps/web` 仍是最终选择和装配入口。

前端只能通过 API client 取数，必须覆盖 loading、empty、error、retry、无权限和成功反馈；用户可见字符串进入模块 i18n。前端的“可见/不可见”仅是体验，服务端 services 授权才是安全边界。

## 5. 环境变量、配置与应用基础设施（Application Infrastructure）

### 5.1 宿主初始化

一个 server 进程只有一个宿主：`apps/server`。它负责解析 assembly、汇总已启用模块的 env 声明、统一读取并校验 `process.env`，创建进程级 DB client，然后调用 `@fenix/platform-sdk/server` 的 `initializeApplicationInfrastructure()` 完成唯一初始化；模块开始运行前必须完成这一步。进程关闭时，连接池和其他进程资源也只由 `apps/server` 释放。

```ts
const installedModules = resolveEnabledModules(assemblyProfile, generatedModuleRegistry);
const env = loadServerEnv(installedModules.flatMap((module) => module.envDefinitions ?? []));

initializeApplicationInfrastructure({
  database: createDatabase(env.DATABASE_URL),
  moduleConfigs: splitModuleConfigs(installedModules, env),
});

const application = assembleApplication({ installedModules });
```

`@fenix/platform-sdk/server` 只提供应用基础设施的受限注册和读取入口，例如 `getDatabase()` 与 `getModuleConfig(moduleId)`；它不读取环境变量、不导入 Drizzle、不创建连接池，也不包含领域逻辑。包只能依赖这个稳定入口，不得导入 `apps/server` 的 env、config、db 或内部路径。

### 5.2 模块配置

模块只声明自己确实需要的部署级配置。`envDefinition` 至少包含字段名、Zod schema、默认值、是否 secret、是否 restart-required、所属模块和用途说明；同名字段的 schema、默认值或 secret 属性冲突时启动失败。模块运行时从应用基础设施读取自身已校验的只读配置，不读取 `process.env`，也不加载 `.env` 文件。

```ts
import { getModuleConfig } from "@fenix/platform-sdk/server";

const config = getModuleConfig<AgentRuntimeEnv>("agent-runtime");
```

绝大多数资源模块不需要 env：名称、模型、Skill、发布状态等是数据库业务配置。只有数据库连接、对象存储、模型网关、Sandbox 地址、第三方密钥等部署级、连接级或启动级配置使用 env；可运行时修改的业务配置存数据库。

### 5.3 应用基础设施的适用边界

应用基础设施只放“整台 server 共用、启动时创建、关闭时释放”的东西：目前是数据库 client 和各模块已校验的只读配置。

| 可以放 | 不可以放 |
| --- | --- |
| DB client、只读部署配置，以及以后同样由 server 统一创建和关闭的基础设施 | AgentConfigService 等业务 service、Repository、Resource Facade、授权实现、当前用户/组织、请求上下文、事务、资源实例 |

判断很简单：某个对象如果会随请求、用户、组织、事务或资源不同而变化，就不能放进应用基础设施；需要时通过函数参数、包公开 API 或 app 装配传递。

`IdentityDirectory` 是本节的**唯一**新增例外，且只因为它通过上面的判据：它是进程级只读投影，不随请求、用户、组织、事务或资源变化，语义上等同于 DB client 的另一种读法。它在 `@fenix/platform-sdk/server` 通过 `registerIdentityDirectory()` 注册、由 identity 实现、由 `apps/server` 在装配时注入；包的深度调用点（runtime 启动参数、观察投影、系统管理投影）因此不必逐层透传参数。它的接口只暴露只读查询，不含授权判断、事务、写入或请求上下文；任何随请求变化的身份数据都必须继续走 `ActorContext` 参数传递，不得经此入口。

包可以直接调用 `getDatabase()`、`getModuleConfig()`，但只能在实际处理请求、任务或启动逻辑时调用，不能在文件加载时调用；否则模块可能早于 server 初始化。未初始化或读取未声明配置时必须报错。测试使用 reset/override API 设置独立的 DB 和配置，不修改全局 `process.env`，也不 mock `apps/server`。

Logger 保持 `@fenix/logger` 的独立进程级日志入口，不进入应用基础设施，也不得被用作领域服务定位器。

### 5.4 密钥与前端边界

- `deploy/env/*.example` 是部署模板的真相来源，只有变量名、说明和非敏感样例；真实 `.env` 永不提交。
- 密钥来自部署平台 secret store、Docker/K8s secret 或受控文件，应用日志、错误响应、测试 fixture 和诊断包均不得输出其值。
- 子进程、Sandbox、Provider 只能获得按模块显式构造的环境白名单，不能透传整个 `process.env`。
- 前端 `apps/web` 不读取 server env，也永远拿不到 secret。公开构建配置由独立 `webEnv` 声明；运行时变化的品牌、导航和功能开关从受控的 `/web` 配置接口读取。

## 6. 数据库、Drizzle 与数据迁移

### 6.1 Schema 所有权

关系型主存储默认 PostgreSQL + Drizzle。表和索引的 Schema 只在模块内维护；根目录的 `drizzle.config.ts` 只是 Drizzle 工具配置，不定义或 re-export 任何表：

```text
packages/resources/agent-config/db/schema.ts         # 模块拥有字段语义
packages/resources/agent-config/db/data-migrations/  # 模块拥有的业务数据迁移
drizzle.config.ts                                    # schema: [模块 schema 文件路径...]，仅供生成工具读取
drizzle/                                             # 本仓库生成的不可变 DDL 链与 meta
```

DDL 链留在仓库根 `drizzle/`，不搬进 `db/`：`drizzle.config.ts` 的 `out` 与 `scripts/migrate.ts` 的 `migrationsFolder` 都显式指向 `./drizzle`，搬动要同步这两处配置，并移动已发布链的 28 条 SQL、snapshot、journal 与 `README.md`（其中含历史 `db:push` 库的基线化命令），却没有任何行为收益。`db/` 的仓库级职责由 `data-migration-runner.ts` 承担，与 DDL 链位置无关。

例如 CE 的配置直接列出已装配模块：

```ts
schema: [
  "./packages/platform/identity/db/schema.ts",
  "./packages/resources/agent-config/db/schema.ts",
]
```

**跨模块外键的 schema 组装期例外。** 表之间可以存在跨模块外键，而 Drizzle 的 `.references()` 与 `foreignKey()` 只接受列对象——没有字符串名或延迟解析的写法。因此被引用表不在同一文件时，引用方**只能**在组装期导入对方的 `db/schema.ts`：

```ts
// packages/resources/memory/db/schema.ts
import { agentConfig } from "@fenix/agent-config/db";

export const agentMemoryConfig = pgTable("agent_memory_config", {
  agentConfigId: text("agent_config_id").references(() => agentConfig.id, { onDelete: "cascade" }),
});
```

这是 §2.2 与 §2.3 的**唯一例外**，边界有三条：

1. **只允许 `packages/**/db/**` 路径**。`src/**`、`web/**` 里出现跨包 schema 导入仍按 §2.2 / §2.3 判定为违规——调用期只能经包根入口公开的 service / DTO 取数。`agent-runtime` 对 `resources` 的反向禁则同理只约束 `src/**`（`environment.agent_config_id` 是既有跨模块外键）。
2. **不构成包级依赖边**。它在 `package.json` 里仍要显式声明依赖（§2.1），但不进入 `dependsOn` / registry 的装配顺序：`db/**` 不参与模块装配，因此不会把资源模块的启用范围绑在一起。
3. **由路径作用域门禁强制，不进按包对匹配的例外台账**。台账是「包对」粒度，一条 schema 例外会连同该包的 `src/**` 一起放行，等于废掉整条禁则；实现见 `scripts/lib/architecture-boundary-rules.ts` 的 `special-dependency` 与 `.dependency-cruiser.cjs` 的 `agent-runtime-not-to-resources`。

### 6.2 迁移规则

1. 变更模块 schema，更新模块 schema manifest。
2. 通过仓库的 `db:generate --name <module>-<change>` 生成当前仓库 migration。
3. 审查 SQL、snapshot、journal；DDL 仅处理结构。
4. 有存量数据时，新增独立、幂等、可观测的数据迁移；记录完成标识与批次进度。

已经被正式环境消费的 migration 不可改写。

### 6.3 数据迁移按模块就近维护、按仓库统一执行

数据迁移依赖资源字段、历史状态和业务不变量，因此代码与 schema 一样归所属模块维护：

```text
packages/resources/agent-config/db/data-migrations/
└── 20260906-backfill-launch-source.ts
```

根 `db/data-migration-runner.ts` 不放迁移业务逻辑，只在发布任务中静态汇总已装配模块导出的 migration manifest，做依赖排序、分批执行、日志/指标、失败停止和完成记录。每个迁移使用全局唯一 ID，格式为 `<模块>/<YYYYMMDD>-<名字>`（日期取该迁移首次进入仓库的日期），例如 `agent-config/20260906-backfill-launch-source`。ID 一旦落 `data_migrate_record` 即成为发布契约：runner 以 ID 判断是否已应用，改名会被判为未应用而重跑。因此**已应用的迁移不改名**，本格式只约束新增迁移（既有历史 ID 保持原样）。每个迁移须声明：

- `dependsOn`：必须已完成的 DDL 或数据迁移 ID；
- `run(context)`：可重试、幂等、按批处理的迁移实现；
- `verify(context)`：确认迁移结果完整的校验；
- `compensation`：失败或回滚时的补偿方案；
- 预期数据量、锁风险和可观测字段。

跨模块数据迁移应归属发起变更的模块，并显式声明依赖；不能为了复用而让迁移调用运行中的 service，因为该 service 的当前业务行为可能已经不兼容历史数据。迁移使用受限的 repository/SQL adapter，且只由部署发布任务执行，不在每个应用进程启动时自动执行。

## 7. 结构化日志与请求关联

当前诊断仅复用 `@fenix/logger`：它输出结构化日志，并通过 `requestAls` 自动注入 `requestId`、用户和组织上下文。HTTP 请求由 `src/plugins/logger.ts` 在入口生成 `requestId`，写入 ALS，并通过 `X-Request-Id` 返回给调用方；不新增 `platform/observability`、`Logger`、`AuditRecorder`、`Metrics` 或 `Tracer` 抽象。

异步任务、实例、队列和 relay 若由 HTTP 请求触发，必须在其显式输入与诊断日志中保留触发方的 `requestId`；独立调度或启动流程在自身入口建立新的关联 ID。services 记录关键状态转换，adapters 记录重试、超时和外部依赖失败，且不在每层重复记录同一错误。控制台系统日志页只读取经过权限过滤的日志投影，不得直接暴露底层日志文件。

日志不得记录 token、Cookie、密码和连接串。对 prompt、文件内容与外部响应正文的脱敏另有要求，见 §11「优化项」。审计、指标和分布式 tracing 不是当前平台能力；出现真实产品或运维需求时，另立设计与任务，不预设跨版本端口。

## 8. 部署、构建和运行脚本

`scripts/` 只做薄编排，不承载业务逻辑：

| 脚本 | 职责 |
| --- | --- |
| `check-module-boundaries` | 检查禁止依赖与公开入口 |
| `migrate` | 运行当前仓库的 DDL 迁移 |
| `run-data-migrations` | 执行已登记且幂等的数据迁移 |
| `release` | 串联迁移、部署与失败判断 |

`deploy/compose` 使用“基础编排 + 可选 profile/overlay”：主服务、数据库、模型网关、知识库、Sandbox 等可独立启停。模块声明其依赖服务与健康检查；部署入口根据静态装配的模块生成/选择 profile，而不是由业务代码自行启动 Docker。

本节仅规定通用构建及部署职责。

## 9. 对现有工程切面的覆盖

以下是目标架构对现有功能分类的归属映射；本节仅定义长期职责，不规定功能拆迁顺序。

| 当前功能分类 | 目标落位/扩展模型 |
| --- | --- |
| 身份、组织、API Key、资源权限 | platform identity/access-control |
| Agent 配置、Skill、MCP、模型、知识库、站点 | resources；基础 CRUD + 各自 domain/services；模型域由单一 `@fenix/model` 承载 Provider 聚合根与严格继承其权限的 Model 二级资源 |
| Environment、Instance、Runtime、relay、ACP session、Chat、YJS | `@fenix/agent-runtime` 统一组合原 `src` 运行编排；基础实现继续归属 `@fenix/core`、`@fenix/orchestration`、`@fenix/chat-channel`、`@fenix/remote-runtime` |
| 文件、机器、Sandbox | Machine/Sandbox 保持独立资源 owner 和 DB/Web，但作为 Runtime 固定基础资源由 `@fenix/agent-runtime` 依赖其专用公开运行入口；严格禁止反向依赖 Runtime，Sandbox 多实现走 Provider 插件点 |
| 工作流、任务、Webhook、调度 | 独立资源或编排模块；通过 Agent 公开 port 接入，节点、执行器、触发器为静态插件 |
| 控制台壳、导航、业务页面、品牌 | apps/web 壳 + resources 模块内的 `web/`；静态 contribution |
| 其中「导航」的分工 | 分组定义与组间顺序归 **Shell**；导航项（id / groupId / order / i18n 命名空间 / labelKey / icon）与其文案归**各资源模块的 `web/contribution.ts`**——资源模块不得反向决定全局布局 |
| 应用 HTTP、MCP/ACP/Webhook/SSE/WS | 模块 server route contribution + app 协议聚合 |
| DB、数据迁移、日志、部署、系统管理 | 仓库级 `db/`、`deploy/`、`@fenix/logger` 与应用日志入口；模块显式贡献 |

因此，当前已知切面均有归属：领域能力走 resources/console，身份与授权走 platform，Agent 运行能力走单一 `@fenix/agent-runtime`，执行 adapter/provider 走对应模块，交付与治理走 apps/db/deploy/docs。最终结果必须满足下列一致性验收标准。

## 10. 最终架构一致性验收标准

本节定义目标状态，不规定固定迁移步骤、任务编号或执行顺序。实施工具必须结合执行时的真实代码、依赖、测试、迁移和部署状态持续拆解工作，直至所有条目同时成立。

### 10.1 目录与模块所有权

1. 所有源码、DB schema、数据迁移、route、Web 页面和生命周期实现均位于[目录归属说明](./ce-ee-engineering-directory-structure.md)指定的唯一 owner，不存在 app 与 package、旧包与新包之间的重复实现。
2. `packages/resources/identity-admin` 已按职责拆分并删除：身份、组织、成员、认证/API Key 进入 `packages/platform/identity`；跨模块控制流进入 app use case 或实际动作 owner；观察能力进入 Observer；不得保留兼容包或 re-export shim。
3. 每个有状态平台/资源模块都完整拥有实际需要的 domain/service/repository/adapter/schema、DB、route/Web contribution、manifest、测试和 README；没有真实用例的目录或抽象不因模板而创建。

### 10.2 依赖与公开边界

1. workspace 编译依赖与第 2.3 节矩阵一致、无循环、无跨包 `src/**` 或相对路径穿透；每个依赖均在消费包 `package.json` 显式声明。
2. 精确的特殊依赖只包括经设计登记的边：`access-control → identity`、`agent-runtime → sandbox/machine`、`sandbox → machine`。Machine/Sandbox 不反向依赖 Runtime；新增例外必须先修改权威设计并通过用户评审。另有一条经用户评审登记的**路径作用域例外**（2026-09-21）：`packages/**/db/**` 可导入其他模块 `db/schema.ts` 的表对象以表达跨模块外键，口径与边界见 §6.1；它不构成包级依赖边。
3. `package.json` dependency、manifest `dependsOn`、生成 registry 和 assembly 表达同一依赖方向；architecture check 与 dependency-cruiser 能阻断新增违规，而不是依赖人工约定。
4. 根入口和 `./server`、`./web`、专用 runtime-facing subpath 的运行环境边界明确；浏览器入口不得经任何重导出链加载 Node、DB 或服务端模块。

### 10.3 Platform、授权与租户隔离

1. `platform-sdk` 不含具体身份、角色、表、DB/Web 实现；Identity 与 AccessControl 保持两个包。
2. 所有外部资源动作由 Resource Facade 使用可信 ActorContext 和 `AccessControlModule` 授权；Domain Service 不接受 actor，repository 不读取成员/角色，也不复制授权 SQL。
3. 普通列表查询在数据库分页、排序和计数之前下推授权约束；详情、更新、删除和运行与列表使用同一范围语义。Provider 是模型授权聚合根，Model 不建立独立 owner/visibility。
4. 旧 `resource_permission` 读取、写入、公开出口和表仅在所有消费者完成结果核验后删除；最终状态不存在双写、兼容表或两套授权判断路径。阶段 2 任务 1.2 交付的是「读者/写者/出口全部删除、表与三个 pg enum 延至下一发布 DROP」——`visibility` 回填迁移与读取切换同批上线时旧表保留，用于核验回填结果；延期期间该表无任何引用，`schema.ts` 以 `removeWhen` 标注移除条件。目标状态不变。
5. 多租户、跨组织、owner/admin/member、系统管理员、private/public、API Key 组织恢复及保守拒绝路径均有自动化回归证据。

### 10.4 Runtime 与基础资源

1. AgentConfig Facade 完成 `use` 授权、引用有效性和 LaunchSpec 解析后，Runtime 只接收已授权的通用启动输入；Runtime 不查询资源表，不解释 actor、role、scope、visibility 或发布状态。
2. Runtime 仅通过 Machine/Sandbox 专用公开运行入口使用注册、心跳、文件、在线状态和执行环境供给能力；资源管理 CRUD 和授权不泄漏进 Runtime。
3. HTTP/OpenAI、Workflow、交互式 Chat 三条路径复用唯一 Runtime/relay/ACP 规则，并保持持久 runtime、lease、session、YJS、ACP/RCS ID、重连、背压及 dispose 不变量。
4. Machine 远端不可用时不得静默回退本地文件系统；workspace 路径、symlink 越界、消息大小、超时、取消、并发和资源释放边界均有测试。

### 10.5 应用宿主与前端

1. `apps/server` 只保留进程入口、协议聚合、认证 adapter、OpenAPI、通用错误/CORS/static/logger、环境变量、应用基础设施初始化边界和通用关闭编排；不得枚举具体业务模块或承载领域规则。
2. `apps/web` 只保留最终 Shell、登录与全局 Provider、品牌/布局/导航容器、错误边界和薄 TanStack route adapter；资源页面、API client、hook、组件和 i18n 归所属模块 `./web`。
3. 资源 Web 流程覆盖 loading、empty、error、retry、无权限、成功反馈和可访问性；前端可见性不是服务端授权替代品。
4. 已发布 `/api/*`、内部 `/web/*`、ACP/MCP/hooks/WS/SSE 只有薄协议 adapter，不存在第二套业务实现；稳定消费者合同未经独立评审不得改变。

### 10.6 DB、配置、装配与交付

1. 表和索引 schema 只由 owner 模块维护，`drizzle.config.ts` 只显式聚合当前仓库 owner；已发布 SQL、snapshot 和 journal 不被改写。
2. 数据迁移由 owner 模块提供唯一 ID、依赖、幂等分批 run、verify、可观测字段和 compensation；仓库 runner 只排序执行，应用启动不隐式运行业务数据迁移。
3. server 进程只在宿主统一读取和校验 env；模块声明配置并通过应用基础设施读取自身已校验的只读配置，Repository 通过应用基础设施读取同一进程唯一的 db client。模块不导入 `apps/server` 的 env/config/db，不读取 `process.env`；secret 不进入日志/响应，子进程和 Provider 只获得白名单。
4. profile 只能选择生成 registry 中的可信模块；模块 ID、kind、依赖、capability、env、migration 和外部服务在流量切换前完成 preflight，失败时已获取资源按逆序释放。
5. `scripts/` 只做薄编排。发布物应包含的内容与发布证据（版本、SBOM、兼容说明、migration/env manifest、备份点、readiness、失败回滚、不可逆迁移补偿）另有要求，见 §11「优化项」。

### 10.7 完成证据

1. 关键数据迁移重试/verify/compensation、生产镜像启动与关闭均通过。
2. 关键用户流程、稳定协议、多租户授权、三条 Agent 通信路径、YJS、Machine/File/Sandbox、Task/Workflow 均有自动化回归证据。
3. `bun run precheck`、`bun run build:web`、`bun run docs:build` 和关键 E2E 全部通过，且没有 error 或 warning。
4. 旧实现、兼容 shim、双写和待决设计矛盾为零；边界豁免与依赖残留必须逐条登记并写明 owner 与移除条件，**未登记的**残留为零；实际架构、开发指南、运维说明和必要 ADR 与代码一致。

## 11. 优化项（非必须）

下列条目是明确的改进方向，但**不作为验收必须项**：不做不阻塞交付，做了提升长期可维护性。它们不进 §10 的一致性验收，本节是唯一登记处。

| 项 | 内容 | 原出处 |
| --- | --- | --- |
| migration smoke | CI 对空库与真实历史升级库执行迁移链，防迁移链回归（含历史 `db:push` 库的基线化路径）。迁移当前已在真实库经应用启动命令（`docker-compose.yml` 的 `bun migrate.js && …`）按**增量路径**跑通；自动化 smoke 补的是「空库一次跑完全链」与「升级库」这两条尚未验证的路径 | §6.2 规则 5；§10.7.1 |
| 日志内容脱敏 | 不在日志中记录完整 prompt、文件内容与未脱敏外部响应正文（含为 `@fenix/logger` 补 redact 配置）。当前有 13 处调用把 prompt 正文与 Agent 响应**截断后**写入日志（形如 `text: promptText.slice(0, 200)`、`JSON.stringify(result).slice(0, 500)`）——截断不改变「明文入日志」的性质。改法：改记长度、摘要或结构化标记 | §7 |
| deploy-preflight | 部署前置的只读校验：env、DB 连通性、迁移状态、镜像版本、依赖服务。作用是把失败提前到「还没动生产」的时刻——现状只有容器启动命令 `bun migrate.js && …` 兜底，属于「边做边发现」，迁移改到一半失败会留下需补偿的不一致状态。五类中 DB 连通性与迁移状态价值最高（env 校验启动期已有）；依赖服务健康检查需先给 `ModuleManifest` 加「依赖服务 + 健康检查」字段 | §8 脚本表；§6.2 规则 5 |
| 发布物清单 | 发布物附带版本清单、SBOM、兼容说明、migration manifest、env manifest。现状只带 `commitId`（`Dockerfile` 的构建参数仅 `GIT_COMMIT_SHA`），上述清单一项都没有；原 `build-release` 脚本（构建 server/console 并生成版本与 SBOM 信息）不存在，与本节同属一件事 | §8 脚本表；§10.6.5 |
| readiness 与发布证据 | readiness 端点（区分进程存活与就绪）、备份点、失败回滚、不可逆迁移补偿证据。现状 `/health` 恒 ok 只表达进程存活，无 readiness 端点；备份点、回滚与补偿均无脚本或文档 | §10.6.5；§6.2 规则 5 |
