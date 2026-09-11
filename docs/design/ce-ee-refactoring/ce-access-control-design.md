# CE 用户、组织与资源权限模型设计

> 状态：已确定采用「资源主表归属列 + `visibility` 默认受众」方案。归属复用资源主表现有 `organization_id` 与 `user_id`，并与 `visibility` 一起由 `ResourceScope` 对资源领域输出；CE 的公开范围由资源主表字段表达。不使用 `resource_context JSONB` 或 `resource_access_grant`。

## 1. 已确定的边界

CE 沿用现有用户、组织和成员体系。所有来自 HTTP、Web 或外部调用方的资源读、写、运行或列表操作，都必须经 `AccessControlModule` 访问；资源领域、route、前端不得自行读取 member/role 或自行解释 `visibility`。

`AccessControlModule` 是业务模块唯一依赖的资源访问入口，负责：

1. 基于可信主体和资源定义，在资源主表写入初始归属；
2. 校验单个资源的 `read`、`update`、`delete`、`use` 等动作；
3. 为列表查询生成并编译数据库授权条件；
4. 屏蔽资源主表归属列与 `visibility` 的物理细节。

业务模块只声明资源类型、主键与归属列、动作和业务筛选条件。它不应复制授权 SQL。对资源 Facade、Route 与 Web 保持相同的访问接口。

约束如下：

1. 资源 ID 是 CRUD、关联、URL 与授权定位的唯一标识；`name` 只是展示或搜索属性。
2. 所有受控资源主表的 `organization_id` 是所属组织真相来源；`user_id` 是该资源的 owner / 创建者真相来源。资源定义必须明确它是否作为访问 owner 使用。
3. 列表授权必须下推到数据库；禁止先读取全量记录后在内存过滤、拼接资源列表。
4. runtime 不读取 actor、归属、角色或 `visibility`；资源 Service/Façade 完成授权与状态校验后才调用 runtime。
5. 前端请求不得传入可信归属或授权判断结果；归属由 AccessControl 基于可信 actor 写入，`visibility` 仅由已获资源管理权限的 Facade 更新。
6. `publish`、`approve` 等资源特有策略不加入所有资源共用的授权动作；它们由对应领域的窄策略接口处理。

## 2. CE 身份、归属与授权语义

### 2.1 用户、组织与成员关系

继续以现有认证模块为真相来源，不新增第二套身份表：

```text
users
└── id

organizations
└── id

organization_members
├── organization_id
├── user_id
└── role: owner | admin | member
```

- `owner`：组织级管理与普通组织资源管理。
- `admin`：普通组织资源管理；组织所有权和成员管理仍由 owner 处理。
- `member`：默认读取资源模块声明为可读的组织资源，并管理自己在当前组织内的个人资源。

### 2.2 资源定义与动作

```ts
export type ResourceAction = "read" | "create" | "update" | "delete" | "use";
export type OwnershipMode = "organization" | "organization-personal" | "personal";
export type ResourceVisibility = "private" | "public";

export type ResourceDefinition = {
  type: string;
  ownershipMode: OwnershipMode;
  actions: readonly ResourceAction[];
  memberDefaultActions: readonly Extract<ResourceAction, "read" | "use">[];
};
```

三类归属语义由 `ResourceScope` 的可选属性表达，而不写死为资源业务字段：

| 类型 | 示例 | 语义 |
| --- | --- | --- |
| `organization` | 组织 AgentConfig | 归属于一个组织；组织角色决定默认访问。 |
| `organization-personal` | 组织内个人定时任务 | 归属于一个组织和一个用户；切换组织后隔离。 |
| `personal` | 用户偏好 | 仅归属于用户；可跨组织可见。 |

### 2.3 `ResourceScope`、固定归属列与默认受众

`ResourceScope` 是资源领域稳定的类型化范围接口，不绑定 CE 的列名或 EE 的存储实现。CE 不再将它序列化到 JSONB；当前 `ColumnResourceScopeStore` 将主表固定列映射为范围对象。

```ts
export type ResourceScope = {
  organizationId?: string;
  ownerUserId?: string;
  visibility: ResourceVisibility;
};
```

每个可授权资源主表继续使用既有归属列作为唯一存储真相：

```text
agent_configs
├── id
├── organization_id              # ResourceScope.organizationId
├── user_id                      # ResourceScope.ownerUserId
├── visibility                   # private | public
└── AgentConfig 业务字段
```

业务模块不接触原始列；Resource Scope Store 批量读取、校验并映射后，Service 返回版本类型化的资源元数据：

```ts
/** 当前 actor 对当前资源的有效动作；不属于资源自身的 ownership。 */
export type ResourceAccess = {
  actions: readonly ResourceAction[];
};

export type ResourceRecord<TData, TScope> = TData & {
  scope: TScope;
  access: ResourceAccess;
};

export type AgentConfigRecord = ResourceRecord<AgentConfigData, ResourceScope>;
```

`scope` 是资源自身、与访问者无关的归属与可见性信息；`access` 是当前 actor 的有效动作。列表与详情均返回各资源自己的 `access`，前端不得根据范围、角色或 `visibility` 自行推导权限。

```ts
/** 平台实现负责主表列与范围对象的转换；资源模块只接收已校验的 TScope。 */
export interface ResourceScopeStore<TScope> {
  initialize(input: { resourceType: string; resourceId: string; scope: TScope }): Promise<void>;
  getMany(input: {
    resourceType: string;
    resourceIds: readonly string[];
  }): Promise<Map<string, TScope>>;
  update(input: {
    resourceType: string;
    resourceId: string;
    scope: TScope;
  }): Promise<void>;
  remove(input: { resourceType: string; resourceId: string }): Promise<void>;
}
```

`visibility` 是资源自身的默认受众，不是 actor 的授权快照；它与组织、owner 一起由 `ResourceScope` 承载，并由同一个 Store 映射固定主表列。通用资源主表只保存 `private` 或 `public`：`private` 不扩大 `ResourceScope` 已定义的范围，组织资源仍按同组织角色策略访问，组织内个人和个人资源仍按其 owner 规则访问；`public` 在原有归属规则外，允许任意已认证用户取得该资源声明的默认公开动作。

通用资源的 `public` 不创建匿名入口：它只在现有已认证资源入口中对全平台用户生效。Site 一类资源仍保留自己的 `private`、`org`、`authenticated`、`public` 访问范围；其中 Site 的 `public` 才允许匿名访问，并可附带发布 token、域名白名单和限流。

| 访问范围 | 权威来源 |
| --- | --- |
| 默认范围（owner、同组织角色等） | 资源主表归属列 + `ResourceDefinition` + 成员角色策略 |
| 全局默认可见 / 可用 | 资源主表 `visibility = public` + 已认证 actor |
| 对外发布 | 资源专属发布字段或发布实体 |

本方案不引入通用的 `resource_access_grant`。若未来 EE 出现定向跨组织、用户组或角色分享的真实需求，应单独确定其主体、动作、审计和查询模型，不反向改变 CE 的默认受众语义。

## 3. 稳定访问接口

### 3.1 可信主体

认证层创建可信主体。route、前端和资源 Service 不得自行声明角色或成员关系。

```ts
export type ActorContext = {
  kind: "user";
  userId: string;
  /** 系统管理员仍保留真实 userId，便于审计；由 AccessControl 解释其系统级权限。 */
  systemRole?: "super-admin";
  activeOrganizationId?: string;
  memberships: ReadonlyArray<{
    organizationId: string;
    role: "owner" | "admin" | "member";
  }>;
};
```

调度器不是天然全权主体。它执行任务时必须带入任务的可信执行上下文，并重新校验其引用 AgentConfig 的 `use` 权限。

全局系统管理员使用带 `systemRole: "super-admin"` 的 `user` actor。`AccessControlModule` 对该身份按系统级规则放行，并在审计中保留真实用户。迁移、运维和模块内部调用不构造 actor，直接使用受信任的 Domain Service；当前不定义 `system` actor。

### 3.2 外部 Facade 与内部 Domain Service

资源包将用户授权与领域复用分开：

```text
route / 外部调用
  → Resource Facade（AccessControl、状态校验、跨资源编排）
  → Domain Service（无 actor、无用户权限判断）
  → Repository
```

`SkillFacade.get(actor, skillId)` 等 Facade 方法是唯一外部入口，先校验 Skill 权限后调用 `SkillService.getById(skillId)`。后者是包根入口公开的 Domain Service，可被同一后端的受信任资源模块复用，不是第二套 HTTP API。

例如用户已有 `AgentConfig.use` 后，AgentConfig Facade 可以读取该配置持久化绑定的 Skill ID，并直接调用 `SkillService` 取得运行数据；不需要、也不应再把当前用户拿去校验 Skill 的独立访问权限。该规则不授予用户 Skill 的独立读取、编辑或下载权限；route 不得直接调用 `SkillService`，且被引用 Skill 删除、禁用或失效时运行必须失败。创建/编辑 AgentConfig 时，是否允许引用某个 Skill 仍由 AgentConfig Facade 按产品规则校验。

### 3.3 `AccessControlModule`

对资源模块公开的接口保持存储无关。实现内部可以查询成员、主表归属列与 `visibility`，也可以将约束编译为 Drizzle SQL 条件；这些细节不得泄漏给业务模块。`ResourceScopeStore` 由同一平台实现提供，负责组织、owner、`visibility` 的批量读取、校验与生命周期维护。

```ts
/** 不透明的列表访问条件；资源模块不得解析其内部结构。 */
export type ResourceQueryConstraint = Readonly<{
  resourceType: string;
  action: "read" | "use";
}>;

export interface AccessControlModule {
  /** 基于可信 actor 写入资源主表的初始归属。 */
  initializeResourceAccess(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<void>;

  /** 详情、修改、删除、运行等单资源操作的统一校验。 */
  authorize(input: {
    actor: ActorContext;
    action: ResourceAction;
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<void>;

  /** 生成列表授权范围，供授权查询能力下推到数据库。 */
  createListConstraint(input: {
    actor: ActorContext;
    action: "read" | "use";
    resource: ResourceDefinition;
  }): Promise<ResourceQueryConstraint>;

}
```

### 3.4 授权查询能力

`ResourceQueryConstraint` 只用于普通用户的受控集合查询。Domain Service 的 `list()` 可选接收该条件：Resource Facade 调用时必须传入；系统管理 Facade 在完成系统管理员校验后、以及受信任资源模块内部调用时可以省略。省略不是“空权限”或对外绕过，而是无权限 Domain Service 的正常内部调用路径；route 不得直接调用它。

Repository 不直接解释 `ResourceQueryConstraint`。平台提供统一的 `AuthorizedResourceQuery`，接收受控资源的 ID、组织与 owner 列以及业务条件，调用已装配的 `AccessControlModule` 生成最终数据库条件。

```ts
class AgentConfigService {
  /**
   * access 只由普通用户的 Facade 传入；系统管理和内部模块可省略。
   * Service 不解析 access，也不自行判断权限。
   */
  list(input: AgentConfigListInput, access?: ResourceQueryConstraint) {
    return this.repository.list(input, access);
  }
}

class AgentConfigRepository {
  constructor(private readonly authorizedQuery: AuthorizedResourceQuery) {}

  list(input: AgentConfigListInput, access?: ResourceQueryConstraint) {
    if (!access) return this.listWithoutAccess(input);

    return this.authorizedQuery.list({
      resourceType: "agent_config",
      columns: {
        id: agentConfigs.id,
        organizationId: agentConfigs.organizationId,
        ownerUserId: agentConfigs.userId,
        visibility: agentConfigs.visibility,
      },
      table: agentConfigs,
      access,
      businessWhere: [eq(agentConfigs.status, input.status)],
    });
  }
}
```

因此 Repository 不知道成员表、角色、`ResourceScope` 的物理列或 `visibility` 查询细节。普通用户 Facade 漏传 access 属于安全错误，应以 route/Façade 边界测试防止；访问实现切换时，替换的是 `AccessControlModule`、`ResourceScopeStore` 及 `AuthorizedResourceQuery` 的实现，不改 Route、Service、Web 和资源领域逻辑。

### 3.5 授权 SQL 的规则

授权过滤与当前 actor 的有效动作都由资源主表归属列、`visibility` 和成员角色策略在数据库查询中确定。禁止先读取全量资源后在内存过滤资源列表。

```sql
-- 查询 1：由数据库完成授权过滤、排序和分页。
SELECT r.*
FROM agent_config AS r
WHERE (
  <ownership-policy-allows-read>
  OR (
    r.visibility = 'public'
    AND <authenticated-actor-policy-allows-read>
  )
)
AND <business-where>
ORDER BY <business-order>
LIMIT <limit> OFFSET <offset>;
```

查询结果按归属、`visibility` 与成员角色策略推导 `access.actions`。资源特定动作蕴含规则在推导时执行：例如 AgentConfig 的 `read` 可蕴含 `use`，但不蕴含 `update` 或 `delete`。

详情、更新、删除、运行必须复用同一归属、`visibility` 与成员角色规则或 `authorize()`，不能另建不一致的判断路径。资源主表按实际查询补齐 `(organization_id, visibility, ...)` 及组织内个人资源所需的 `(organization_id, user_id, ...)` 索引；索引顺序须以最终 `EXPLAIN` 结果验证。

## 4. Resource Scope Store 演进

当前 `ColumnResourceScopeStore` 从各资源主表的 `organization_id`、`user_id` 与 `visibility` 读取和写入范围对象，不使用 JSONB 或额外归属表。资源创建、归属或公开范围更新和删除必须与对应资源行处于同一事务。

未来若 EE 需要不同范围模型或集中治理，可替换为其自己的 `ResourceScopeStore` 实现，并返回扩展的 `EnterpriseResourceScope`。只要资源模块始终通过 Store 读取/写入范围对象、通过统一授权查询能力筛选资源，Service、Facade、Route、Web 及 `ResourceRecord<TData, TScope>` 调用接口均不需要修改。

## 5. CE 默认规则

1. 纯个人资源：owner 可完整管理。
2. 组织内个人资源：owner 在对应组织内可完整管理。
3. 普通组织资源：同组织 `owner` / `admin` 可执行资源声明的基础管理动作；`member` 仅可执行 `memberDefaultActions`。
4. `visibility = public` 只开放资源定义为全局公开声明的默认动作。动作之间是否蕴含由资源定义或资源特定策略明确声明：例如 AgentConfig 可声明公开 `read` 同时允许 `use`；其他资源不得据此默认推导编辑、删除、运行或分享权限。
5. `admin` / `owner` 默认不自动读取或修改组织内个人资源。审计或代管必须另设显式动作和审计能力。

## 6. 迁移规则

1. 为支持全局公开的资源主表增加 `visibility` 固定列；不回填 JSONB。既有通用资源全局公开记录回填为 `visibility = public`；对外 Site 访问仍迁移到 Site 自己的发布范围或发布实体。
2. 不将 `resource_permission` 重命名为 `resource_access_grant`。完成 `visibility` 回填与结果核验后，删除本方案不再使用的旧权限记录和表；不得保留双写或兼容路径。
3. 先让资源 Service 和 Repository 接入第 3 节稳定接口；删除资源模块内直接 `member/role` 判断和手写授权 SQL。
4. 将列表改为资源主表驱动的归属与 `visibility` 条件；验证排序、分页、计数、默认归属范围、公开范围和并发更新边界。
5. 资源创建必须在同一事务中写入主表归属与初始 `visibility`；资源删除不需要额外清理通用授权记录。
6. 完成 ID 集合、公开资源结果和关键授权动作核验后，删除旧权限查询路径；不得长期保留双写或兼容层。
