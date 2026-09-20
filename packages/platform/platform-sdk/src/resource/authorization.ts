import type { MemberRole } from "../identity/identity-directory";

/**
 * 资源授权契约：资源领域、route 与 AccessControl 实现之间的稳定边界。
 *
 * 这些类型不绑定 CE 的物理列名，也不绑定具体存储：资源模块只声明资源类型、主键与归属列、
 * 动作和业务筛选条件，授权判断与 SQL 编译由 `AccessControlModule` 的实现负责。
 */

/** 资源默认可见范围；`public` 仅对已认证主体生效。 */
export type ResourceVisibility = "private" | "public";
export type ResourceAction = "read" | "create" | "update" | "delete" | "use";
export type OwnershipMode = "organization" | "organization-personal" | "personal";

export interface ResourceDefinition {
  readonly type: string;
  readonly ownershipMode: OwnershipMode;
  readonly actions: readonly ResourceAction[];
  readonly memberDefaultActions: readonly Extract<ResourceAction, "read" | "use">[];
  /** `visibility = public` 时对任意已认证用户开放的默认动作；不声明则不开放。 */
  readonly publicDefaultActions: readonly Extract<ResourceAction, "read" | "use">[];
}

/** 资源自身的归属与可见性；与访问者无关，因此不含任何 actor 信息。 */
export interface ResourceScope {
  readonly organizationId?: string;
  readonly ownerUserId?: string;
  readonly visibility: ResourceVisibility;
}

/** 当前 actor 对某个资源的有效动作；不属于资源自身的 ownership。 */
export interface ResourceAccess {
  readonly actions: readonly ResourceAction[];
}

/** 资源领域的版本化元数据：业务数据 + 归属范围 + 当前 actor 的有效动作。 */
export type ResourceRecord<TData, TScope extends ResourceScope = ResourceScope> = TData & {
  readonly scope: TScope;
  readonly access: ResourceAccess;
};

/** 平台实现负责主表列与范围对象的转换；资源模块只接收已校验的 `TScope`。 */
export interface ResourceScopeStore<TScope extends ResourceScope = ResourceScope> {
  initialize(input: { resourceType: string; resourceId: string; scope: TScope }): Promise<void>;
  getMany(input: { resourceType: string; resourceIds: readonly string[] }): Promise<Map<string, TScope>>;
  update(input: { resourceType: string; resourceId: string; scope: TScope }): Promise<void>;
  remove(input: { resourceType: string; resourceId: string }): Promise<void>;
}

/**
 * 可信主体；由身份模块产出，route、前端和资源 Service 不得自行声明角色或成员关系。
 *
 * `memberships` 必须是**全量**成员关系（不是当前 active organization）：actor 是身份的完整投影，
 * 而不是为某次判定裁剪出的视图。
 *
 * 全量**不是**可见范围：组织资源的可见范围只有 `activeOrganizationId` 一个组织，成员关系仅用于
 * 回答"actor 在当前组织里是什么角色"。授权不得把它展开成组织 ID 的并集。
 */
export interface ActorContext {
  readonly kind: "user";
  readonly userId: string;
  /**
   * 系统管理员仍保留真实 userId，便于审计；由 AccessControl 解释其系统级权限。
   *
   * 预留能力：当前没有任何生产赋值点，`AccessControlModule` 保留该分支的放行语义，待系统管理员
   * 产品形态确定后再补判定规则与回归。在此之前该字段只由测试构造。
   */
  readonly systemRole?: "super-admin";
  readonly activeOrganizationId?: string;
  readonly memberships: readonly { readonly organizationId: string; readonly role: MemberRole }[];
}

/**
 * 授权实现私有「已解析授权事实」的载荷键；资源模块无法合法读取。
 *
 * 谓词编译器与动作推导必须是同一份规则：两者都从该载荷读出同一 `ListPolicyFacts`，而载荷键
 * 只在本包与实现包内可见，资源模块既不能构造也不能解析该条件。
 */
export const RESOURCE_QUERY_CONSTRAINT_PAYLOAD: unique symbol = Symbol("fenix.resource-query-constraint");

/** 不透明的列表访问条件；资源模块不得解析其内部结构，也不得自行构造。 */
export type ResourceQueryConstraint = Readonly<{
  resourceType: string;
  action: "read" | "use";
  /** 产出该条件的授权实现 ID；条件编译器校验一致，防止跨实现混搭。 */
  provider: string;
  [RESOURCE_QUERY_CONSTRAINT_PAYLOAD]: unknown;
}>;

export interface AuthorizationInput {
  readonly actor: ActorContext;
  readonly action: ResourceAction;
  readonly resource: ResourceDefinition;
  readonly resourceId: string;
}

/**
 * 业务模块唯一依赖的资源访问入口。
 *
 * 实现内部可以查询成员、主表归属列与 `visibility`，也可以把约束编译为具体 SQL；这些细节不得
 * 泄漏给业务模块。
 */
export interface AccessControlModule {
  readonly id: string;
  /**
   * 创建期的初始归属。
   *
   * 归属列位于资源主表且为 `NOT NULL`：没有 id 就无法先行写入，因此归属必须在 INSERT 之前解析、
   * 并由同一条 INSERT 写入，不能先建行再补写。
   */
  resolveInitialScope(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    /** 仅系统管理 Facade 可显式指定目标组织；普通主体的归属由 activeOrganizationId 决定。 */
    organizationId?: string;
  }): Promise<ResourceScope>;
  /**
   * side-table 型 `ResourceScopeStore`（EE）的独立初始化路径。
   *
   * CE 使用主表归属列，创建期走 `resolveInitialScope`，不调用本方法。
   */
  initializeResourceAccess(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<void>;
  /** 详情、修改、删除、运行等单资源操作的统一校验。 */
  authorize(input: AuthorizationInput): Promise<void>;
  /** 生成列表授权范围，供授权查询能力下推到数据库。 */
  createListConstraint(input: {
    actor: ActorContext;
    action: "read" | "use";
    resource: ResourceDefinition;
  }): Promise<ResourceQueryConstraint>;
  /** 给出单个资源在当前 actor 下的有效动作，供 Resource Facade 组装 `access`。 */
  resolveAccess(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<ResourceAccess>;
  /** 列表批量版本，避免逐行 `resolveAccess` 造成的 N+1。 */
  resolveAccessMany(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    resourceIds: readonly string[];
  }): Promise<ReadonlyMap<string, ResourceAccess>>;
}
