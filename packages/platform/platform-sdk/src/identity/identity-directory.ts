import type { ApiSystemUserRecord } from "../protocol/system-api";

/**
 * 身份目录：资源侧读取身份数据的唯一合法窄契约。
 *
 * 设计约束（ce-ee-engineering-standards §2.3）：资源包不得依赖具体 Identity 包。资源模块需要
 * 用户展示信息、组织名录、成员关系判断或系统托管租户时，只能依赖本接口；实现由
 * `packages/platform/identity` 提供，宿主（`apps/server`）在装配时注入。
 *
 * 本契约是纯只读投影，不承载任何授权语义：它不判断动作、不返回归属范围、不参与事务。
 * 需要授权的资源读取必须经 `AccessControlModule`，不得把本接口当作权限旁路。
 */

/** 成员在组织中的角色；与 `ActorContext.memberships` 使用同一取值域。 */
export type MemberRole = "owner" | "admin" | "member";

/** 用户展示信息投影；不含密码哈希、会话、API Key 等凭据字段，也不含手机号等非必要 PII。 */
export interface UserDisplayInfo {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

/** 组织名录投影。 */
export interface OrganizationSummary {
  readonly id: string;
  readonly name: string;
  readonly slug?: string;
  /**
   * 组织 `metadata` 中的默认引擎机器引用；未配置时为 null。
   *
   * 只暴露这一个稳定字段：机器退役前的引用校验需要它，而 `metadata` 的其余内容属组织内部配置，
   * 不进入模块间契约。
   */
  readonly defaultMachineId?: string | null;
}

/** 成员关系投影。 */
export interface MembershipSummary {
  readonly organizationId: string;
  readonly role: MemberRole;
}

/** 组织成员投影，用于系统人员树等系统管理视图。 */
export interface OrganizationMemberSummary {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly phoneNumber: string | null;
  readonly role: MemberRole;
}

/** 组织及其成员投影。 */
export interface OrganizationWithMembers {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly members: readonly OrganizationMemberSummary[];
}

/**
 * 用户检索入参。
 *
 * `organizationId` 存在时结果限定为该组织的成员；`userId` 精确限定单个用户；`keyword` 对
 * 姓名、邮箱与手机号做模糊匹配。三者可组合。
 */
export interface UserSearchInput {
  readonly keyword?: string;
  readonly organizationId?: string;
  readonly userId?: string;
}

/**
 * 系统托管租户：builtin 资源与模型网关 provider 的宿主组织与账号。
 *
 * `userId` / `email` 是审计主体——系统托管资源的 `user_id` 列必须写真实用户 ID，不得伪造
 * actor；`email` 同时用于资源元数据里的 owner 展示。`organizationSlug` 与 `organizationId`
 * 一起构成宿主组织标识，因为既有消费方（模型网关 provider 元数据）同时需要两者。
 */
export interface SystemTenant {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly userId: string;
  readonly email: string;
}

/**
 * 身份只读投影端口。
 *
 * 实现方只能返回投影字段；调用方不得据此推断权限，也不得把结果缓存到请求之外
 * （成员关系与组织名录会随用户操作变化）。
 */
export interface IdentityDirectory {
  /** 按 ID 批量读取用户展示信息；缺失的 ID 不出现在结果中。 */
  listUserDisplayInfo(userIds: readonly string[]): Promise<ReadonlyMap<string, UserDisplayInfo>>;
  /** 读取单个用户展示信息；不存在时返回 undefined。 */
  getUser(userId: string): Promise<UserDisplayInfo | undefined>;
  /** 按登录名读取用户展示信息；同名多行时返回最早创建的一行。 */
  findUserByName(name: string): Promise<UserDisplayInfo | undefined>;
  /**
   * 按管理端条件检索用户，返回 `/api/system/*` 的完整用户记录。
   *
   * 只有系统管理面需要 `emailVerified` / `phoneNumber` 等账号状态字段；模块间的普通展示
   * 需求必须走 {@link listUserDisplayInfo}，避免账号状态无差别扩散。
   */
  searchUsers(input: UserSearchInput): Promise<readonly ApiSystemUserRecord[]>;
  /** 按 ID 批量读取组织名称；缺失的 ID 不出现在结果中。 */
  listOrganizationNames(organizationIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** 读取单个组织名录信息；不存在时返回 undefined。 */
  getOrganization(organizationId: string): Promise<OrganizationSummary | undefined>;
  /**
   * 解析成员关系行 ID；不存在时返回 undefined。
   *
   * 该 ID 是既有外部约定的稳定标识（例如 Hindsight bank ID），不是授权判据：调用方不得据
   * 此推断成员权限，权限判断一律走 `AccessControlModule`。
   */
  resolveMembershipId(input: { organizationId: string; userId: string }): Promise<string | undefined>;
  /**
   * 读取用户在全部组织中的成员关系；无成员关系时返回空数组。
   *
   * 顺序必须按成员关系创建时间升序（`member.createdAt`，同值再按 `member.id`），调用方依赖
   * 该顺序确定确定性默认组织（通常是注册时创建的个人组织），不得返回未定义顺序。
   */
  listMemberships(userId: string): Promise<readonly MembershipSummary[]>;
  /**
   * 读取系统托管租户，必要时完成系统管理员引导；引导失败时抛错，不返回空值让调用方静默退化。
   *
   * 该方法是系统托管资源的唯一入口：调用方不得自行创建系统管理员或猜测宿主组织。
   */
  resolveSystemTenant(): Promise<SystemTenant>;
  /** 读取全部组织及其成员，用于系统管理视图。 */
  listOrganizationsWithMembers(): Promise<readonly OrganizationWithMembers[]>;
}
