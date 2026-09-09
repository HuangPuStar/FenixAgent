# CE / EE 工程架构与开发规范

> 状态：ARC-02 基础平台公共契约已冻结。AgentConfig、Agent runtime 与强依赖资源的具体 package、route、Web 和 starter 内容仅作为 ARC-03 输入草案，不属于本阶段冻结结果。
>
> 权威输入：[`ce-access-control-design.md`](./ce-access-control-design.md) 定义 CE `resource_context` 与 Context Store；[`ce-ee-refactoring-collaboration-plan.md`](./ce-ee-refactoring-collaboration-plan.md) 的任务总表定义阶段、direct prerequisite 与领取状态。ARC-01、AGT-00 在各自分支记录现状，合并前不作为 ARC-02 的文件依赖。

## 1. 目标与基本决策

目标是在两个仓库中以较小团队成本交付商业版，并允许后续为多个甲方静态定制：

1. CE 不含 EE 或甲方业务代码；EE 通过 Git submodule 固定引用 CE revision。
2. 身份、租户和授权允许整体替换，不要求 EE 继承 CE 角色或 Context schema。
3. 资源基础 CRUD 尽量复用；发布、审批、客户字段和流程由 EE/客户模块扩展。
4. 模块由 manifest 自描述，构建期扫描可信 workspace 生成静态 registry；运行时只从已编译候选中按 assembly 选择，不扫描、下载或热加载代码。
5. 基础实现使用中性 `@fenix/*`；EE 替换或扩展使用 `@fenix-ee/*`。CE/EE 是产品线和装配关系，不进入基础领域命名。
6. 只为真实替换、多实现或循环边界建立 port；单一场景直接实现，不建设“所有资源都是动态插件”的平台。

长期依赖方向：

```text
apps/server · apps/web
        ↓
platform implementations · resources · agent
        ↓
platform-sdk / local stable ports

EE apps/packages → CE public exports
CE apps/packages -X→ EE packages
```

Resource Facade 负责可信主体、授权、资源状态和业务编排；Domain Service 供受信任后端内部复用；repository 只处理持久化；runtime 不读取 actor、角色、Context、资源状态或资源表。协议 DTO、领域对象、持久化记录、Web ViewModel 和 runtime input 在边界处独立转换。

## 2. ARC-02 与 ARC-03 的边界

| stage | frozen here | explicitly deferred |
| --- | --- | --- |
| ARC-02 基础平台 | platform/app package identity；module/assembly/env 形态；DB/transaction、observability、认证主体到 AccessControl 的依赖与拒绝语义 | 资源与 Agent 的具体 exports、route、Web contribution 和 runtime DTO |
| ARC-03 首个资源闭环 | 本文只保存输入草案，等待 ARC-01、ARC-02、AGT-00 后统一冻结 | AgentConfig/Agent/九类依赖资源的 package/module、starter、`/app`、Web 与迁移范围 |

ARC-02 已确认跨 CE/EE 使用中性 opaque `ActorContext`，`access-control` 是 singleton capability；默认与 EE provider 使用不同 module ID 装配到同一 slot，资源模块不包含 edition 分支。

## 3. 阅读导航与 canonical owner

| detail | canonical ownership | stage |
| --- | --- | --- |
| [模块与静态装配](./ce-ee-engineering-architecture/modules-and-static-assembly.md) | 目录、公开面、三类依赖、module/assembly、registry、bootstrap、env | ARC-02；Agent capability 部分标 ARC-03 draft |
| [资源、API 与 Web 边界](./ce-ee-engineering-architecture/resource-api-web-boundaries.md) | Facade/Domain Service/repository、route/协议、Web Shell、扩展放置 | 通用边界；具体资源 identity 归 ARC-03 |
| [AccessControl 契约](./ce-ee-engineering-architecture/access-control-contract.md) | `ActorContext`、`ResourceContext`、Context Store、constraint、拒绝/查询/事务/审计 | ARC-02 |
| [AgentConfig 与 runtime 边界](./ce-ee-engineering-architecture/agent-config-runtime-boundary.md) | 九类依赖、starter、InstanceManager、三类生命周期 | ARC-03 输入草案 |
| [数据、可观测性与交付](./ce-ee-engineering-architecture/data-observability-delivery.md) | DB/transaction、migration、observability、env/deploy/submodule | ARC-02 平台部分；资源 schema 归后续阶段 |
| [迁移、治理与测试](./ce-ee-engineering-architecture/migration-governance-testing.md) | 阶段验收、垂直切片、stable ID、测试隔离与回滚 | 全阶段治理；task truth 回链协作计划 |

同一表、规则或候选签名只在其 owner 出现一次；其他文件只摘要并链接。CE Context 的字段、索引和迁移只由 `ce-access-control-design.md` 维护。

## 4. Identity summary

状态说明：`existing` 表示当前 workspace 已有 package 骨架；`ARC-02 target` 是本阶段冻结的平台/app identity；`ARC-03 draft` 需后续阶段确认，不能视为已冻结 export。

| status | package | module | kind | exports | route / Web | capability or dependency |
| --- | --- | --- | --- | --- | --- | --- |
| existing → ARC-02 target | `@fenix/server-app` | none | none | private app | server composition root | enabled server modules |
| existing → ARC-02 target | `@fenix/web-app` | none | none | private app | product Shell | enabled Web contributions |
| existing → ARC-02 target | `@fenix/platform-sdk` | none | none | `.`, platform subpaths owned by FND-03 | none | neutral contracts |
| existing → ARC-02 target | `@fenix/access-control` | `access-control-default` | `platform` | `.` | none | provides singleton `access-control`; requires observability |
| existing → ARC-02 target | `@fenix/observability` | `observability-default` | `platform` | `.` | none | provides singleton `observability` |
| ARC-03 draft | `@fenix/agent-engine-sdk` | none | none | `.` | none | engine contract |
| existing package / ARC-03 manifest draft | `@fenix/claude-code`、`@fenix/opencode`、`@fenix/ccb` | provider-specific | `runtime` | `.` | none | provide multi-provider `agent-engine` |
| ARC-03 draft | `@fenix/agent-runtime` | `agent-runtime-default` | `runtime` | `.` | none | runtime singleton |
| ARC-03 draft | `@fenix/agent-instance` | `agent-instance-default` | `runtime` | `.` | none | instance starter singleton |
| existing package / ARC-03 draft | `@fenix/agent-config` | `agent-config` | `resource` | `.`, `./db`, `./web` | `/app/agent-configs`; Web `agent-config` | depends on first-slice resources |
| ARC-03 draft | Model、Provider、Skill、MCP、Knowledge、Memory、Environment、Agent Node、Sandbox、Site App packages | resource-specific | `resource` | `.`, optional `./db`/`./web` | owner task defines | no resource capability slots |

Package、module、capability、route 与 Web ID 是不同 namespace。Module/Web ID 在各自 registry 中全局唯一并使用 kebab-case。SDK/app 不为形式统一注册 module；resource 不依赖 `*-default` implementation ID。Agent 和资源的具体 package/export/module/route 值由 ARC-03 最终冻结。

## 5. 对现有工程切面的覆盖

| current concern | target placement |
| --- | --- |
| 身份、组织、API Key、资源 Context 与权限 | platform identity/tenancy/access-control，可整体替换 |
| DB connection、transaction、migration runner | platform DB boundary + repository adapters |
| Logger、Audit、Metrics、Trace | platform observability + app context propagation |
| AgentConfig、Skill、MCP、模型、知识库、记忆、环境、站点 | resources，具体闭环由 ARC-03 |
| instance、engine、ACP、relay、session control | agent/runtime，不承载资源授权 |
| app HTTP、协议入口、Web Shell | apps composition roots + module contributions |
| migration、deploy、release、operations | repository-level db/deploy/docs governance |

当前代码、历史 route 和数据模型在对应垂直切片切换前仍是运行基线；目标设计不会自动改变其合同或授权删除旧实现。

## 6. 集中后置决定

| decision | owner | blocks | does not block |
| --- | --- | --- | --- |
| `/app` 的 401 envelope、403 与 anti-enumeration 404 | API/architecture owner | ARC-03 route contract | ARC-02 platform error categories |
| `POST /app/agent-configs/:id/run` 产品语义、DTO 和 Environment/instance/relay owner | product + Agent owner | RES-01/WEB-02 run flow | ARC-02 与通用 runtime isolation |
| 现有 `/api/agents`、connect、OpenAI-compatible endpoint 的逐项保留、版本化或退役 | external API owner | 对应合同改变/删除 | 保持合同并原子重接新 Facade |
| Knowledge/Memory/Site/Environment binding 物理 owner | DAT + resource owners | 对应 schema/migration | 逻辑 owner 与依赖方向 |
| AgentConfig delete cleanup exact contract | ENV/AGT/RES owners | delete implementation | fail-closed cleanup responsibility |

CE 权限存储不再待定：基础版本采用资源主表 `resource_context JSONB` 与平台 `ResourceContextStore`。当前不设计定向 share/grant；未来真实需求另行评审。

ARC-02 不为后置决定创建 ADR。只有形成高反转、长期且已批准的决定时才单独评估 ADR。

## 7. 验收与变更规则

ARC-02 冻结架构高度的职责、依赖方向、数据分类和失败语义，不冻结 constructor、generic query executor、Unit of Work、内部并发协议、schema 字段或完整 manifest schema。FND/PLT 实现任务必须在这些不变量内选择最小形状并通过 contract tests。

验收本设计集时检查：

- ARC-02 与 ARC-03 状态没有混用；
- AccessControl、Context Store、DB/transaction、observability、assembly/env 的平台边界足以独立实现；
- server/Web registry 和 root/`./db`/`./web` value graph 物理隔离；
- ARC-03 草案没有被描述成当前公共 export；
- 相对链接存在，内容没有复制成第二真相；
- 后置决定明确 owner 和阻塞范围，没有伪装为已冻结结论。

签字后若要改变公共平台边界，必须说明消费者、迁移、观测、回滚以及 CE/EE 影响，再决定更新设计或建立 ADR。
