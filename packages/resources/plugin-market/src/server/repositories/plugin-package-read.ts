import type {
  AuthorizedResourceQuery,
  QueryStorageTypes,
  ResourceQueryConstraint,
  ScopedRow,
} from "@fenix/platform-sdk";
import { pluginMarketPublication } from "@fenix/resource-plugin-market/db";
import { inArray, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { pluginPackageResource } from "../access/plugin-package-resource";
import { getPluginMarketDatabase } from "../db";
import type { PluginPackageRow, PublicationRow } from "./plugin-package";

/**
 * 市场目录的受控读取。
 *
 * 与 `./plugin-package.ts`（写侧）分开成两个文件不是为了对称，而是因为两侧的**授权前提相反**：写侧由
 * `withPackageLock` 串行化并假定调用方已授权，读侧每次查询都要自己回答「这次读的是谁的可见集合」——带主体
 * 时把授权谓词交给平台编译进同一条 SQL，管理面（系统凭据、无主体）则不带 `access`，见
 * `PluginPackageReadInput`。混在一个文件里，读者无法一眼看出哪些函数带 `access`、哪些不带。
 *
 * 聚合根（`plugin_market_package`）一律经 {@link AuthorizedResourceQuery} 端口读取：本包只交出表、归属列
 * 与业务条件，谓词、排序与分页由平台实现产出，仓储因此**不持有任何组织、角色或 `visibility` 判断**。
 *
 * 版本行（`plugin_market_publication`）是聚合的一部分，**没有独立授权**：它的可见范围就是所属包的可见
 * 范围，因此对它的读取不带授权谓词，但只能由「已经按包授权」的调用方发起，且入参是包 ID 集合——包 ID 只
 * 可能来自上面那条受控查询。这样授权判定的产出点仍然只有一处（本文件上方的端口），而不是每个子查询各判
 * 一次、判得还不一致。
 */

/**
 * 本包对授权查询端口的存储类型实例化（与 `./plugin-package.ts` 同因：端口在 `platform-sdk` 上用 `unknown`
 * 槽位保持与存储无关，资源包在自己的仓储里收窄一次以保留 Drizzle 的完整类型校验）。
 */
export interface PluginPackageQueryStorage extends QueryStorageTypes {
  readonly table: PgTable;
  readonly column: PgColumn;
  readonly condition: SQL;
  readonly order: SQL;
  readonly row: PluginPackageRow;
}

/** 授权查询产出的包行：主表业务列 + 平台解析出的归属范围。视图投影（`domain/package-view.ts`）消费它。 */
export type ScopedPluginPackageRow = ScopedRow<PluginPackageRow>;

/** 受控读取的公共入参；`businessWhere` 由调用方（读侧服务）按业务口径拼装。 */
export interface PluginPackageReadInput {
  /**
   * 列表授权条件；**管理面不传**，此时本仓储退化为「按业务条件读取」。
   *
   * 这个可选性是平台端口的既定形状（`AuthorizedResourceQuery` 的说明），不是本包的宽松默认：省略它意味着
   * 「这次读取不属于任何主体」，只允许系统管理 Facade 走。因此**没有任何 route 可以到达这里**——它们只能
   * 经 Facade 的具名方法，而那几个方法各自固定了自己要不要传 `access`。
   */
  readonly access?: ResourceQueryConstraint;
  readonly businessWhere?: readonly SQL[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface PluginPackageReadRepository {
  /** 列表 + 总数；两者共用同一份授权条件与业务条件，不会建立在两个不同的可见集合上。 */
  listReadable(input: PluginPackageReadInput): Promise<{ items: readonly ScopedPluginPackageRow[]; total: number }>;
  /** 取首行；定位条件（来源、包名、是否含整包下架的条目）由调用方经 `businessWhere` 给出。 */
  findReadable(input: PluginPackageReadInput): Promise<ScopedPluginPackageRow | undefined>;
  /** 按包 ID 批量读取版本行；入参为空时**不查库**（空 `IN ()` 在 SQL 里是恒假，多一次往返没有意义）。 */
  listPublications(input: { readonly packageIds: readonly string[] }): Promise<PublicationRow[]>;
}

/** 主表归属列的唯一定义来自资源注册，仓储不再重复声明列名。 */
const storage = pluginPackageResource.storage;

export function createPluginPackageReadRepository(
  query: AuthorizedResourceQuery<PluginPackageQueryStorage>,
): PluginPackageReadRepository {
  /** 组装端口所需的查询目标；条件按需拼装，避免把 `undefined` 传进端口。 */
  function target(input: PluginPackageReadInput) {
    return {
      resourceType: storage.resourceType,
      table: storage.table,
      columns: storage.columns,
      ...(input.access === undefined ? {} : { access: input.access }),
      ...(input.businessWhere === undefined ? {} : { businessWhere: input.businessWhere }),
    };
  }

  return {
    async listReadable(input) {
      const page = await query.list({
        ...target(input),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.offset === undefined ? {} : { offset: input.offset }),
      });
      const total = await query.count(target(input));
      return { items: page.items, total };
    },

    async findReadable(input) {
      // 走 `list` 而不是 `findById`：定位键是业务列（来源 + 包名 + 可见性口径），不是资源 ID。
      const page = await query.list({ ...target(input), limit: 1 });
      return page.items[0];
    },

    async listPublications(input) {
      if (input.packageIds.length === 0) return [];
      return getPluginMarketDatabase()
        .select()
        .from(pluginMarketPublication)
        .where(inArray(pluginMarketPublication.packageId, [...input.packageIds]));
    },
  };
}
