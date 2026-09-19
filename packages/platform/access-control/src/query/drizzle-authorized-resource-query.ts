import {
  type AuthorizedResourceCountInput,
  type AuthorizedResourceFindInput,
  type AuthorizedResourceListInput,
  type AuthorizedResourceQuery,
  type QueryStorageTypes,
  RESOURCE_QUERY_CONSTRAINT_PAYLOAD,
  type ResourcePage,
  type ResourceQueryConstraint,
  type ScopedRow,
} from "@fenix/platform-sdk";
import { and, count, eq, type SQL } from "drizzle-orm";
import { type AccessControlDatabase, isMissingScopeStoreBinding } from "../database";
import type { ListPolicyFacts } from "../policy/policy-facts";
import { type ResolvedScopeColumns, resolveScopeColumns, scopeOfRow } from "../scope/scope-columns";
import { buildAuthorizationPredicate } from "./build-predicate";

/**
 * 授权查询的 Drizzle 实现。
 *
 * 它把不透明条件里的已解析授权事实编译成谓词，与业务条件一起下推到 SQL：授权过滤、排序、分页
 * 和计数都发生在数据库里，禁止先读全量再在内存过滤（设计 §3.5）。资源模块只交出表、归属列与
 * 业务条件，不需要知道成员关系、角色或 `visibility` 的判定细节。
 *
 * `bindings` 与 `ColumnResourceScopeStore` 共享同一份资源类型注册：未注册的资源直接报错——把
 * 查询落到"没有归属列"的主表上会静默放宽授权。
 */
export class DrizzleAuthorizedResourceQuery<TStorage extends QueryStorageTypes = QueryStorageTypes>
  implements AuthorizedResourceQuery<TStorage>
{
  constructor(
    private readonly database: AccessControlDatabase,
    private readonly provider: string,
    private readonly resourceTypes: ReadonlySet<string>,
  ) {}

  async list(input: AuthorizedResourceListInput<TStorage>): Promise<ResourcePage<ScopedRow<TStorage["row"]>>> {
    const resolved = this.resolveTarget(input);
    const where = this.buildWhere(input);
    // `$dynamic()` 允许按需追加 ORDER BY / LIMIT / OFFSET：业务条件与授权谓词已经在 WHERE 里，
    // 排序与分页因此作用在已授权集合上。
    let query = this.database.select().from(resolved.table).where(where).$dynamic();
    const order = (input.businessOrder ?? []) as SQL[];
    if (order.length > 0) query = query.orderBy(...order);
    if (input.limit !== undefined) query = query.limit(input.limit);
    if (input.offset !== undefined) query = query.offset(input.offset);
    const rows = (await query) as Record<string, unknown>[];
    return { items: rows.map((row) => this.attachScope(resolved, row) as ScopedRow<TStorage["row"]>) };
  }

  async count(input: AuthorizedResourceCountInput<TStorage>): Promise<number> {
    const resolved = this.resolveTarget(input);
    const where = this.buildWhere(input);
    const rows = await this.database.select({ value: count() }).from(resolved.table).where(where);
    return Number(rows[0]?.value ?? 0);
  }

  async findById(input: AuthorizedResourceFindInput<TStorage>): Promise<ScopedRow<TStorage["row"]> | undefined> {
    const resolved = this.resolveTarget(input);
    const where = this.buildWhere(input, eq(resolved.id, input.resourceId));
    const rows = (await this.database.select().from(resolved.table).where(where).limit(1)) as Record<string, unknown>[];
    const row = rows[0];
    return row === undefined ? undefined : (this.attachScope(resolved, row) as ScopedRow<TStorage["row"]>);
  }

  private resolveTarget(input: {
    resourceType: string;
    table: TStorage["table"];
    columns: AuthorizedResourceListInput<TStorage>["columns"];
  }): ResolvedScopeColumns {
    if (!this.resourceTypes.has(input.resourceType)) throw isMissingScopeStoreBinding(input.resourceType);
    return resolveScopeColumns(input);
  }

  private buildWhere(
    input: {
      resourceType: string;
      columns: AuthorizedResourceListInput<TStorage>["columns"];
      access?: ResourceQueryConstraint;
      businessWhere?: readonly TStorage["condition"][];
    },
    extra?: SQL,
  ): SQL | undefined {
    const facts = this.readFacts(input);
    const predicate = facts === undefined ? undefined : buildAuthorizationPredicate(facts, input.columns);
    const business = (input.businessWhere ?? []) as SQL[];
    // 谓词与业务条件同处一个 WHERE：联合下推才能让排序与分页作用在已授权集合上。
    return and(...[predicate, extra, ...business]);
  }

  /**
   * 读取不透明条件里的授权事实。
   *
   * 只接受本实现产出的条件：`provider` 与资源类型都一致，载荷结构由本包定义。跨实现混搭会让
   * 谓词与动作推导分叉，因此直接拒绝，而不是尽力解释别人的载荷。
   */
  private readFacts(input: { resourceType: string; access?: ResourceQueryConstraint }): ListPolicyFacts | undefined {
    const access = input.access;
    if (access === undefined) return;
    if (access.provider !== this.provider) {
      throw new Error(`授权条件由 ${access.provider} 产出，不能由 ${this.provider} 编译`);
    }
    if (access.resourceType !== input.resourceType) {
      throw new Error(`授权条件属于资源 ${access.resourceType}，不能用于 ${input.resourceType}`);
    }
    const facts = access[RESOURCE_QUERY_CONSTRAINT_PAYLOAD];
    if (facts === undefined || facts === null) throw new Error("授权条件缺少已解析的授权事实");
    return facts as ListPolicyFacts;
  }

  /** 行 → `{ ...row, scope }`：范围由主表的归属列还原，与谓词使用同一份列声明。 */
  private attachScope(resolved: ResolvedScopeColumns, row: Record<string, unknown>): Record<string, unknown> {
    return { ...row, scope: scopeOfRow(resolved, row) };
  }
}
