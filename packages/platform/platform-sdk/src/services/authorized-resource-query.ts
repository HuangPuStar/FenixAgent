import type { ResourceQueryConstraint, ResourceScope } from "../resource/authorization";
import type { ResourceScopeColumns } from "../resource/registration";
import type { ResourcePage } from "../resource/resource-page";

/**
 * 统一授权查询端口。
 *
 * 资源 Repository 不解释 `ResourceQueryConstraint`：它只把受控资源的表、归属列与业务条件交给
 * 平台实现，由实现生成最终数据库条件（含授权谓词与排序、分页）。`platform-sdk` 不导入 Drizzle，
 * 因此端口用「存储类型包」把具体存储参数化，默认槽位是 `unknown`；资源包在自己的
 * Repository 里用自己的 Drizzle 类型实例化，从而保留完整类型校验。
 */
export interface QueryStorageTypes {
  readonly table: unknown;
  readonly column: unknown;
  readonly condition: unknown;
  readonly order: unknown;
  readonly row: unknown;
}

/** 授权查询产出的资源行：主表业务列 + 平台解析出的归属范围。 */
export type ScopedRow<TRow> = TRow & { readonly scope: ResourceScope };

interface AuthorizedQueryTarget<TStorage extends QueryStorageTypes> {
  readonly resourceType: string;
  readonly table: TStorage["table"];
  readonly columns: ResourceScopeColumns<TStorage["column"]>;
  /** 不透明的列表/详情授权条件；系统管理 Facade 与受信任内部调用不传。 */
  readonly access?: ResourceQueryConstraint;
  readonly businessWhere?: readonly TStorage["condition"][];
}

export interface AuthorizedResourceListInput<TStorage extends QueryStorageTypes>
  extends AuthorizedQueryTarget<TStorage> {
  readonly businessOrder?: readonly TStorage["order"][];
  readonly limit?: number;
  readonly offset?: number;
}

export type AuthorizedResourceCountInput<TStorage extends QueryStorageTypes> = AuthorizedQueryTarget<TStorage>;

export interface AuthorizedResourceFindInput<TStorage extends QueryStorageTypes>
  extends AuthorizedQueryTarget<TStorage> {
  readonly resourceId: string;
}

/**
 * 受控资源的统一授权查询能力。
 *
 * 传入 `access` 时必须下推授权谓词；不传表示无权限 Domain Service 的内部调用路径
 * （例如系统管理 Facade 已完成超级管理员校验、或受信任资源模块复用运行数据），
 * 不是"空权限"或对外绕过——route 不得直接调用无 `access` 的路径。
 */
export interface AuthorizedResourceQuery<TStorage extends QueryStorageTypes = QueryStorageTypes> {
  list(input: AuthorizedResourceListInput<TStorage>): Promise<ResourcePage<ScopedRow<TStorage["row"]>>>;
  count(input: AuthorizedResourceCountInput<TStorage>): Promise<number>;
  findById(input: AuthorizedResourceFindInput<TStorage>): Promise<ScopedRow<TStorage["row"]> | undefined>;
}

/**
 * 按资源包的存储类型收窄查询端口。
 *
 * 存储类型只影响编译期校验：宿主装配时拿到的是默认（`unknown` 槽位）实例，运行期只有一份实现，
 * 它按每次调用传入的表、归属列与条件工作，不区分存储类型。资源包在自己的组合根里用本函数收窄
 * 一次，此后本包的查询构造都享有完整类型校验；这是该类型参数唯一的转换点，资源包内不得再断言
 * 查询结果的行类型。
 */
export function narrowAuthorizedQuery<TStorage extends QueryStorageTypes>(
  query: AuthorizedResourceQuery,
): AuthorizedResourceQuery<TStorage> {
  return query as AuthorizedResourceQuery<TStorage>;
}
