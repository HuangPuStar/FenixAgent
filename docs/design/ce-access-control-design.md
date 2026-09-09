# CE 用户、组织与资源权限模型设计

> 状态：已确定采用「资源主表内 `resource_context JSONB` + 平台统一 Context Store」方案。当前 Context 只保存归属与公开可见性；业务模块不直接读写或解析它。未来可迁移至统一扩展表，调用接口不变。

## 1. 已确定的边界

CE 沿用现有用户、组织和成员体系。所有来自 HTTP、Web 或外部调用方的资源读、写、运行或列表操作，都必须经 `AccessControlModule` 访问；资源领域、route、前端不得自行读取 member/role、`resource_context` 内容或授权关系表。

`AccessControlModule` 是业务模块唯一依赖的资源访问入口，负责：

1. 根据可信主体和资源定义，创建资源初始归属与可见性；
2. 校验单个资源的 `read`、`update`、`delete`、`use` 等动作；
3. 为列表查询生成并编译授权条件；
4. 屏蔽 `resource_context` 的 JSON 存储和未来扩展表等物理存储差异。

业务模块只声明资源类型、主键列、动作和业务筛选条件。它不应知道权限数据存在哪里，也不应复制授权 SQL。当前 CE 存储实现与未来 EE 存储实现可完全不同。

约束如下：

1. 资源 ID 是 CRUD、关联、URL 与授权定位的唯一标识；`name` 只是展示或搜索属性。
2. 列表授权必须下推到数据库；禁止先读取全量记录再在内存中按组织、角色或版本过滤。
3. runtime 不读取 actor、归属、角色或授权存储；资源 Service/Façade 完成授权与状态校验后才调用 runtime。
4. 前端请求不得直接传入可信的归属、`resource_context` 或授权判断结果；这些值只能由授权模块基于可信 actor 生成或验证。
5. `publish`、`approve` 等资源特有策略不加入所有资源共用的授权动作；它们由对应领域的窄策略接口处理。

## 2. CE 身份与资源语义

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

export type ResourceDefinition = {
  type: string;
  ownershipMode: OwnershipMode;
  actions: readonly ResourceAction[];
  memberDefaultActions: readonly Extract<ResourceAction, "read" | "use">[];
};
```

三类归属语义由 `ResourceContext` 的可选属性表达，而不写死为资源业务字段：

| 类型 | 示例 | 语义 |
| --- | --- | --- |
| `organization` | 组织 AgentConfig | 归属于一个组织；组织角色决定默认访问。 |
| `organization-personal` | 组织内个人定时任务 | 归属于一个组织和一个用户；切换组织后隔离。 |
| `personal` | 用户偏好 | 仅归属于用户；可跨组织可见。 |

公开是默认可见性策略，而不是归属迁移：当前只表达 `private`、当前组织可见、全局公开三种语义。

### 2.3 `resource_context` 存储与返回模型

每个可授权资源主表增加授权层托管的 Context 列：

```text
agent_configs
├── id
├── resource_context JSONB NOT NULL      # 归属与公开可见性上下文
└── AgentConfig 业务字段
```

每张受控资源主表为 `resource_context` 建立 `jsonb_path_ops` GIN 索引。

`resource_context` 是当前基础版本的私有存储协议，由 `AccessControl` 使用统一 Zod schema 创建、解析和更新。JSON 只允许一层 KV：value 只能是 string、boolean、number 或 string 数组；禁止嵌套对象、对象数组和动态 key。

```ts
export type ResourceContext = {
  organizationId?: string;
  ownerUserId?: string;
  visibility: "private" | "organization" | "public";
};
```

业务模块不接触原始 JSON；Context Store 批量读取并校验后，Service 返回版本类型化的资源元数据：

```ts
export type ResourceRecord<TData, TContext> = TData & {
  context: TContext;
};

export type AgentConfigRecord = ResourceRecord<AgentConfigData, ResourceContext>;
```

```ts
/** 平台实现负责 JSON 解析；资源模块只接收已校验的 TContext。 */
export interface ResourceContextStore<TContext> {
  initialize(input: { resourceType: string; resourceId: string; context: TContext }): Promise<void>;
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
```

因此基础版本的 Service 可返回 `organizationId`、`ownerUserId` 与 `visibility`；EE 用相同泛型返回自己的 `EnterpriseResourceContext`，不需要接受组织字段。API DTO 可按产品需要将 `context` 展开或保留为嵌套对象，但不得返回原始未校验 JSON 或授权 SQL。

当前 Store 读取资源主表内的 JSONB。未来需要集中治理时，可迁移为：

```text
resource_contexts
├── resource_type
├── resource_id
├── context JSONB
└── 审计字段
```

只要资源模块始终通过 Store 读取/写入 Context、通过统一授权查询能力筛选资源，就只需回填数据并替换 Store 实现；业务模块、Service 返回模型和 Facade 调用接口均不变。旧主表列可先废弃保留，确认稳定后再统一清理。`resource_type + resource_id` 的多态关联无法建立到所有资源表的真实外键，这是使用扩展表换取资源主表纯净性的已知取舍。

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

对资源模块公开的接口保持存储无关。实现内部可以查询成员、归属和 `resource_context`，也可以将约束编译为 Drizzle SQL 条件；这些细节不得泄漏给业务模块。`ResourceContextStore` 由同一平台实现提供，负责 Context 的批量读取、JSON 校验与生命周期维护。

```ts
/** 不透明的列表访问条件；资源模块不得解析其内部结构。 */
export type ResourceQueryConstraint = Readonly<{
  resourceType: string;
  action: "read" | "use";
}>;

export interface AccessControlModule {
  /** 基于可信 actor 创建资源的初始访问元数据。 */
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

  /** 删除资源时清理授权侧数据；同一事务内执行。 */
  removeResourceAccess(input: {
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<void>;
}
```

### 3.4 授权查询能力

`ResourceQueryConstraint` 只用于普通用户的受控集合查询。Domain Service 的 `list()` 可选接收该条件：Resource Facade 调用时必须传入；系统管理 Facade 在完成系统管理员校验后、以及受信任资源模块内部调用时可以省略。省略不是“空权限”或对外绕过，而是无权限 Domain Service 的正常内部调用路径；route 不得直接调用它。

Repository 不直接解释 `ResourceQueryConstraint`。平台提供统一的 `AuthorizedResourceQuery`，它接收资源类型、资源 ID 列和业务条件，调用已装配的 `AccessControlModule` 实现生成最终数据库条件。

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
    if (!access) {
      return this.listWithoutAccess(input);
    }

    return this.authorizedQuery.list({
      resourceType: "agent_config",
      resourceIdColumn: agentConfigs.id,
      table: agentConfigs,
      access,
      businessWhere: [eq(agentConfigs.status, input.status)],
    });
  }
}
```

因此 Repository 只知道自己是何种资源及其主键，不知道成员表、角色、`resource_context` 或 SQL 拼接规则。普通用户 Facade 漏传 access 属于安全错误，应以 route/Façade 边界测试防止；访问存储实现切换时，替换的是 `AccessControlModule`、`ResourceContextStore` 及 `AuthorizedResourceQuery` 的实现，不改 Route、Service、Web 和资源领域逻辑。

### 3.5 授权 SQL 的规则

实现必须在数据库内完成过滤。当前基础版本将 `resource_context` 编译为资源主表的 JSONB 条件，并为常用 JSON 包含查询建立 GIN 索引；禁止读取全量资源后在内存过滤。

当前没有定向分享或 grant 表：`AccessControl` 只编译归属与 `visibility` 的 JSONB 条件。未来如果出现真实的定向分享需求，独立 grant 表的查询统一使用 `EXISTS` 而不是直接 join，以避免多条授权重复资源行；当前不预设 grant schema 或接口。EE 不复用基础版本的物理表或 Context schema，只实现同一套上层访问接口。

## 4. Context Store 演进

当前 `InlineResourceContextStore` 从各资源主表的 `resource_context` 列读取和写入 Context，不需要跨表关联。未来若真实出现统一治理、跨资源审计或集中管理的需求，可替换为 `ExtensionTableResourceContextStore`，存储到 `resource_contexts(resource_type, resource_id, context, ...)`。

迁移流程为：新建扩展表 → 回填 Context → 替换 Store 和授权查询实现 → 核验受控列表、详情与动作 → 废弃旧列 → 稳定后统一删除。资源模块必须始终通过 Store 和 `AuthorizedResourceQuery`，故 Service、Facade、Route、Web 及返回的 `ResourceRecord<TData, TContext>` 不需要修改。

## 5. CE 默认规则

1. 纯个人资源：owner 可完整管理。
2. 组织内个人资源：owner 在对应组织内可完整管理。
3. 普通组织资源：同组织 `owner` / `admin` 可执行资源声明的基础管理动作；`member` 仅可执行 `memberDefaultActions`。
4. 公开或组织内可见只授予资源声明允许的 `read/use`；不自动等价于编辑、删除或分享。
5. `admin` / `owner` 默认不自动读取或修改组织内个人资源。审计或代管必须另设显式动作和审计能力。

## 6. 迁移规则

迁移某个资源时：

1. 盘点现有组织、owner 和公开标记，定义其到 `ResourceContext` 的映射。
2. 先让资源 Service 和 Repository 接入第 3 节稳定接口；删除资源模块内直接 member/role 判断和手写授权 SQL。
3. 在同一事务内接入资源创建、授权初始化、更新、删除和授权侧清理。
4. 列表、详情、更新、删除、运行均通过 `AccessControlModule` 校验；验证跨组织、公开和并发更新等边界。
5. 完成数据回填、ID 集合和关键列表结果核验后，删除旧权限路径；不得长期双写。

将来迁往扩展表时，业务调用接口不变；只替换 Context Store、授权查询实现并做数据回填。旧 `resource_context` 列可先废弃保留，确认稳定后再统一清理。
