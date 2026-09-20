import type { ResourceScope, ResourceScopeColumns } from "@fenix/platform-sdk";
import { getTableColumns } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

/**
 * 把「主表 + 归属列声明」解析成可用的列句柄与主表行键名。
 *
 * 授权查询与 `ColumnResourceScopeStore` 都需要同一份解析：前者要按列编译谓词，后者要按列读写
 * 范围。列的生命周期只在这里校验一次——声明的列必须真实属于该主表，否则资源注册有误，
 * 静默降级会放宽授权范围。
 */
export interface ResolvedScopeColumns {
  readonly table: PgTable;
  readonly id: PgColumn;
  readonly organizationId?: PgColumn;
  readonly ownerUserId?: PgColumn;
  readonly visibility?: PgColumn;
  /** 主表行对象里的 JS 键名（不是 SQL 列名），用于从 select 结果还原范围。 */
  readonly rowKeys: {
    readonly id: string;
    readonly organizationId?: string;
    readonly ownerUserId?: string;
    readonly visibility?: string;
  };
}

export function resolveScopeColumns<TTable, TColumn>(input: {
  readonly resourceType: string;
  readonly table: TTable;
  readonly columns: ResourceScopeColumns<TColumn>;
}): ResolvedScopeColumns {
  const table = input.table as PgTable;
  const tableColumns = getTableColumns(table);
  const keyOf = (column: TColumn | undefined, name: string): string | undefined => {
    if (column === undefined) return;
    const key = Object.entries(tableColumns).find(([, value]) => value === column)?.[0];
    if (key === undefined) {
      throw new Error(`资源 ${input.resourceType} 存储绑定的 ${name} 列不属于其主表`);
    }
    return key;
  };

  const idKey = keyOf(input.columns.id, "id");
  if (idKey === undefined) throw new Error(`资源 ${input.resourceType} 存储绑定缺少 id 列`);
  const organizationIdKey = keyOf(input.columns.organizationId, "organizationId");
  const ownerUserIdKey = keyOf(input.columns.ownerUserId, "ownerUserId");
  const visibilityKey = keyOf(input.columns.visibility, "visibility");

  return {
    table,
    id: input.columns.id as PgColumn,
    ...(input.columns.organizationId === undefined ? {} : { organizationId: input.columns.organizationId as PgColumn }),
    ...(input.columns.ownerUserId === undefined ? {} : { ownerUserId: input.columns.ownerUserId as PgColumn }),
    ...(input.columns.visibility === undefined ? {} : { visibility: input.columns.visibility as PgColumn }),
    rowKeys: {
      id: idKey,
      ...(organizationIdKey === undefined ? {} : { organizationId: organizationIdKey }),
      ...(ownerUserIdKey === undefined ? {} : { ownerUserId: ownerUserIdKey }),
      ...(visibilityKey === undefined ? {} : { visibility: visibilityKey }),
    },
  };
}

/**
 * 从主表行还原归属范围。
 *
 * 未声明 `visibility` 列的资源不具备公开受众，范围恒为 `private`；这不是默认值兜底，而是该资源
 * 在平台上确实无法表达公开范围。
 */
export function scopeOfRow(resolved: ResolvedScopeColumns, row: Record<string, unknown>): ResourceScope {
  const { rowKeys } = resolved;
  const organizationId = rowKeys.organizationId === undefined ? undefined : (row[rowKeys.organizationId] as string);
  const ownerUserId = rowKeys.ownerUserId === undefined ? undefined : (row[rowKeys.ownerUserId] as string);
  // 通用资源只保存 private / public：只有明确写入的 public 才扩大受众，其余（含 NULL）都按
  // private 处理，避免未知取值被当成公开范围。
  const visibility = rowKeys.visibility !== undefined && row[rowKeys.visibility] === "public" ? "public" : "private";
  return {
    ...(organizationId === undefined || organizationId === null ? {} : { organizationId }),
    ...(ownerUserId === undefined || ownerUserId === null ? {} : { ownerUserId }),
    visibility,
  };
}
