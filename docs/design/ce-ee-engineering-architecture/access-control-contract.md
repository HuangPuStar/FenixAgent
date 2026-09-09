# AccessControl 公共契约

> 本文是 ARC-02 基础平台授权契约的 canonical detail。2026-09-09 已确认中性 opaque `ActorContext` 与 singleton `access-control` 替换边界；CE 的默认规则、`resource_context` schema、索引和迁移细节以 [`ce-access-control-design.md`](../ce-access-control-design.md) 为准。

## 1. 边界与已决存储方向

HTTP、Web、外部 API 和调度任务的资源 `list/read/create/update/delete/use` 必须进入 actor-aware Resource Facade。Route、domain、Web、runtime 与普通 repository 不读取身份或权限存储；资源模块不解析主体 claims、成员、角色或原始 `resource_context` JSON。

AccessControl singleton 负责：

- 根据可信主体和资源定义，为新 stable ID 初始化归属与公开可见性；
- 校验既有资源的单对象动作；
- 签发不可由资源方构造或恢复的 list constraint，并保证数据库查询下推；
- 删除资源时清理授权侧 Context；
- 屏蔽 CE/EE 身份、Context schema 和物理存储差异。

CE 已决定采用“资源主表内 `resource_context JSONB` + 平台统一 `ResourceContextStore`”。当前 Context 只表达归属和 `private | organization | public` 可见性；不设计定向 share/grant。未来真实出现定向分享或集中治理需求时，再独立评审 grant 或 Context 扩展表，现有平台调用边界保持不变。

`AgentInstance` 不是授权资源。AgentConfig Facade 授权 `use` 后才把已解析输入交给 starter；runtime 不接收 actor 或授权结果。Scheduler 只持久化 stable subject/task/tenant selector，每次执行经当前 provider 重建可信 actor并重新授权。

## 2. 最小公共 surface

以下是 ARC-02 冻结的唯一 AccessControl TypeScript block。它表达方法与数据职责，不规定 provider factory、SQL compiler、transaction carrier 或内部查询执行器。

```ts
declare const actorContextBrand: unique symbol;
declare const resourceQueryConstraintBrand: unique symbol;

export type ActorContext = Readonly<{
  readonly [actorContextBrand]: "ActorContext";
}>;

export type ResourceAction = "read" | "create" | "update" | "delete" | "use";
export type OwnershipMode = "organization" | "organization-personal" | "personal";

export type ResourceDefinition = Readonly<{
  type: string;
  ownershipMode: OwnershipMode;
  actions: readonly ResourceAction[];
  memberDefaultActions: readonly ("read" | "use")[];
}>;

export type ResourceContext = Readonly<{
  organizationId?: string;
  ownerUserId?: string;
  visibility: "private" | "organization" | "public";
}>;

export type ResourceQueryConstraint = Readonly<{
  readonly [resourceQueryConstraintBrand]: "ResourceQueryConstraint";
}>;

export interface ResourceContextStore<TContext> {
  initialize(input: {
    resourceType: string;
    resourceId: string;
    context: TContext;
  }): Promise<void>;
  getMany(input: {
    resourceType: string;
    resourceIds: readonly string[];
  }): Promise<Map<string, TContext>>;
  update(input: {
    resourceType: string;
    resourceId: string;
    context: TContext;
  }): Promise<void>;
  remove(input: { resourceType: string; resourceId: string }): Promise<void>;
}

export interface AccessControlModule {
  initializeResourceAccess(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<void>;

  authorize(input: {
    actor: ActorContext;
    action: ResourceAction;
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<void>;

  createListConstraint(input: {
    actor: ActorContext;
    action: "read" | "use";
    resource: ResourceDefinition;
  }): Promise<ResourceQueryConstraint>;

  removeResourceAccess(input: {
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<void>;
}
```

`ActorContext` 是可信主体上下文；`ResourceContext` 是已校验的资源归属元数据，两者不得混用。EE 可以使用自己的 `EnterpriseResourceContext` 和存储实现，不需要继承 CE organization/member 字段；资源 Service 通过泛型 `ResourceRecord<TData, TContext>` 暴露已校验 Context，而不是原始 JSON。

## 3. Legacy disposition

| legacy term or shape | ARC-02 disposition |
| --- | --- |
| resource-facing `ResourceScope` | 不作为独立公共模型；归属语义由已校验 `ResourceContext` 表达 |
| 把 `ResourceContext` 当主体上下文 | 禁止；主体统一为 opaque `ActorContext` |
| `createResourceContext()` 认证工厂 | 若存在，只属于具体认证/provider 内部 |
| `matches()` / 内存授权过滤 | 排除；actor-facing list 必须数据库下推 |
| 可解析 memberships、CE role、enterprise claims | 不向 resource 暴露 |
| optional access 的外部 list | 排除；Facade 漏传 constraint 必须失败，内部全量查询使用独立 actor-free 方法 |
| SQL/Drizzle fragment | 不进入 platform/resource 公共 API |
| public transaction/UoW token | 不在 ARC-02 surface 冻结 |
| 当前 share/grant API | 不创建；出现真实定向分享用例后另行设计 |

Opaque actor/constraint 的具体签发与验证机制由 PLT-01 落地并由默认与 EE provider 的共同 contract tests 证明。资源、route、queue、cache 和 persistence 不得自行构造、复制或反序列化这些值。

## 4. 认证主体与 active organization

认证方法先分支，再确定 tenant 真相来源；不同分支不得互相 fallback：

1. 普通入口先尝试 better-auth session；无 session 时尝试 Environment Secret；仍未认证时尝试 better-auth API Key。
2. Session 的 CE selector precedence 为 `x-active-org-id` header → `activeOrganizationId` query → `active_org_id` cookie。最高优先且已出现的值无效时立即拒绝，不尝试低优先来源。
3. API Key 的 organization metadata 是 authoritative；必须重验 key、organization 和当前成员关系。显式 selector 只能与 metadata 一致。
4. Environment Secret 的 Environment owner/organization 是 authoritative；显式 selector 只能一致，不能切换 tenant。
5. 所选 organization 必须存在且关系当前有效。撤权、校验异常、陈旧 cache 或依赖不可用都 fail closed，不 fallback 到首个组织。
6. Super-admin 保留真实用户身份；只有明确且可审计的系统规则可绕过普通 membership。

跨 CE/EE 的 `ActorContext` 保持中性 opaque。CE user/organization/membership 与 EE service account/workspace/project 都是 provider 私有解释，资源模块不因 CE 默认实现而固化角色模型。

## 5. Context Store 与查询下推

当前 `InlineResourceContextStore` 从各资源主表的 `resource_context` 列批量读取和写入 Context。JSON 使用统一 schema，只有一层 KV；值限标量或字符串数组，禁止嵌套对象、对象数组和动态 key。受控资源主表为常用 JSON 包含查询建立 `jsonb_path_ops` GIN 索引。

Actor-facing list 总是先取得当前 provider 签发的 constraint。资源 package 拥有业务 query/result，AccessControl 拥有授权条件解释；装配后的统一查询能力必须让授权条件与业务 filter、sort、pagination/cursor、total 在同一次数据库查询中执行。

- Provider 不理解资源业务 DTO；资源 repository 不解释 actor claims、member/role 或原始 Context。
- Constraint 与 resource definition、action 和查询用途绑定；foreign、stale、expired 或 mismatched 值在 DB 调用前拒绝。
- 合法主体无可见记录返回空集合；AccessControl/storage outage 返回 unavailable，不伪装为空集合或 deny。
- 受信任内部全量查询使用独立 actor-free Domain Service 方法，不通过省略 constraint 绕过外部路径。

未来若 Context 迁到统一扩展表，只替换 Store 与授权查询实现并执行回填；Facade、Domain Service、route、Web 和 `ResourceRecord<TData, TContext>` 边界不变。

## 6. 事务、失败与审计不变量

| concern | frozen behavior | implementation owner |
| --- | --- | --- |
| create | `initializeResourceAccess` 同时校验 create 并初始化新 ID 的 Context；失败不留下裸资源 | PLT-01 + resource |
| single resource | authorize 成功无返回；deny 抛稳定领域错误，调用方不能忽略 boolean | AccessControl |
| list | constraint 必选；授权与业务条件同一 DB query，分页和 total 基于授权后集合 | PLT-01/02 + repository |
| deny vs outage | unauthenticated、context invalid、access denied、constraint invalid、AccessControl unavailable、audit unavailable 分离且永不 fail-open | platform + route owner |
| create/delete atomicity | 同事务域内 resource/binding 与 Context initialize/remove 原子；异构域使用有限补偿 | PLT-02 + resource |
| audit | deny/outage、initialize/remove、CRUD/use 与补偿可关联且脱敏 | PLT-03 + AccessControl |

Create 不能以伪 ID 预先调用既有资源 authorize。Delete 时 Context 清理失败不能留下被静默遗忘的 orphan。异构步骤的逆操作必须幂等、有限、可观测；补偿失败不覆盖 primary error，并进入 reconciliation。ARC-02 不公开 transaction carrier 或补偿接口形状。

审计只记录 event/time/operation/result/code，以及安全的 actor/tenant/resource/trace reference。禁止 claims、memberships、opaque token、credential、Cookie、header/env、URL query、launch snapshot、prompt/file 或外部原始响应。强制审计不可用时，不得开始需要审计的 mutation 或 start。

## 7. 替换与验收

`access-control` 是 singleton slot。默认与 EE provider 使用不同 module ID，可同时存在静态 registry，但 assembly 恰选一个；resource 只依赖 capability，不依赖默认 ID，也没有 edition branch。

默认与 EE provider 的 contract tests 至少覆盖：认证来源与 selector fail-closed、跨租户隔离、create/initialize、单资源拒绝、constraint 防伪/错配、同查询分页/total、Context Store 生命周期、事务或补偿、审计不可用、Scheduler 重建，以及 resource/runtime 不解析 claims。CE 的 JSONB schema/索引和迁移测试由 `ce-access-control-design.md` 与 PLT/DAT owner维护。
