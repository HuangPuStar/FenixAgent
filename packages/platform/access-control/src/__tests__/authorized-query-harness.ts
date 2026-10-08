/**
 * 授权查询 SQL 层用例的脚手架：fixture、不透明条件、记录型 DB 句柄。
 *
 * 与被测实现的关系：`DrizzleAuthorizedResourceQuery` 照常用 Drizzle 构造真实 SQL，本脚手架只替换
 * **DB 句柄**——把构造结果记录下来，供用例用 `PgDialect` 还原成文本与参数断言，并让 `list` /
 * `count` / `findById` 拿到确定的行。
 *
 * **替身边界**：包级用例没有 Postgres（与 `predicate-evaluator.ts` 同一口径，不引入外部依赖）。
 * 替身按 Postgres 的语义回答请求：先按 WHERE 命中（离线求值器解释 Drizzle 的 SQL chunk 树），
 * 再应用 OFFSET / LIMIT。因此**不覆盖**数据库自身的行为：类型强制与 NULL 语义的细节、排序规则、
 * 索引与执行计划；`ORDER BY` 只被记录、不被执行，切片按 fixture 给定顺序发生。
 *
 * fixture 的行顺序刻意把**别的组织**的行排在前面，让「授权过滤先于切片」这类断言具备区分力——
 * 若实现退化为「先读全量再在内存过滤」，前两行就会是别人的数据。
 */

import type {
  ActorContext,
  QueryStorageTypes,
  ResourceDefinition,
  ResourceQueryConstraint,
  ResourceStorageBinding,
} from "@fenix/platform-sdk";
import { getTableColumns, type SQL } from "drizzle-orm";
import { PgDialect, type PgTable, pgTable, text } from "drizzle-orm/pg-core";
import type { AccessControlDatabase } from "../database";
import { createDrizzleAccessControl } from "../suite";
import { rowSatisfiesPredicate } from "./predicate-evaluator";

/** 资源主表：归属列 `NOT NULL`（真实资源表如此），`visibility` 可空以覆盖「未写明取值」的边界。 */
export const probeTable = pgTable("authorized_query_probe", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  organizationId: text("organization_id").notNull(),
  ownerUserId: text("user_id").notNull(),
  visibility: text("visibility"),
});

const probeColumns = {
  id: probeTable.id,
  organizationId: probeTable.organizationId,
  ownerUserId: probeTable.ownerUserId,
  visibility: probeTable.visibility,
};

export type ProbeRow = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly visibility: string | null;
};

/** 存储类型包：资源包在组合根里做同一次收窄（见 `narrowAuthorizedQuery`），用例沿用同一口径。 */
interface ProbeStorage extends QueryStorageTypes {
  readonly table: typeof probeTable;
  readonly column: (typeof probeColumns)[keyof typeof probeColumns];
  readonly condition: SQL;
  readonly order: SQL;
  readonly row: ProbeRow;
}

export const ORGANIZATION_RESOURCE_TYPE = "query-probe";
export const PERSONAL_RESOURCE_TYPE = "query-probe-personal";

/** 组织资源：成员与公开受众都能 `read`，写动作留给归属角色。 */
export const ORGANIZATION_RESOURCE: ResourceDefinition = {
  type: ORGANIZATION_RESOURCE_TYPE,
  ownershipMode: "organization",
  actions: ["read", "create", "update", "delete", "use"],
  memberDefaultActions: ["read", "use"],
  publicDefaultActions: ["read"],
};

/** 组织内个人资源：与组织资源共用主表，但归属判定多一个 owner 条件。 */
export const ORGANIZATION_PERSONAL_RESOURCE: ResourceDefinition = {
  ...ORGANIZATION_RESOURCE,
  type: PERSONAL_RESOURCE_TYPE,
  ownershipMode: "organization-personal",
};

/** 两个资源类型注册在同一张主表上，模拟宿主把各资源包的存储绑定汇总后交给平台。 */
const PROBE_BINDINGS: readonly ResourceStorageBinding[] = [
  { resourceType: ORGANIZATION_RESOURCE_TYPE, table: probeTable, columns: probeColumns },
  { resourceType: PERSONAL_RESOURCE_TYPE, table: probeTable, columns: probeColumns },
];

/** 两个组织各有一行私有资源，三行公开资源分属三个组织，另有一行 `visibility` 未写明。 */
export const PROBE_ROWS: readonly ProbeRow[] = [
  {
    id: "b-private",
    name: "乙组织私有",
    status: "active",
    organizationId: "org-b",
    ownerUserId: "u4",
    visibility: "private",
  },
  {
    id: "c-public",
    name: "丙组织公开",
    status: "active",
    organizationId: "org-c",
    ownerUserId: "u3",
    visibility: "public",
  },
  {
    id: "a-private",
    name: "甲组织私有",
    status: "active",
    organizationId: "org-a",
    ownerUserId: "u1",
    visibility: "private",
  },
  {
    id: "a-public",
    name: "甲组织公开",
    status: "active",
    organizationId: "org-a",
    ownerUserId: "u1",
    visibility: "public",
  },
  {
    id: "a-archived",
    name: "甲组织归档",
    status: "archived",
    organizationId: "org-a",
    ownerUserId: "u2",
    visibility: "private",
  },
  {
    id: "a-no-visibility",
    name: "甲组织未写明 visibility",
    status: "active",
    organizationId: "org-a",
    ownerUserId: "u1",
    visibility: null,
  },
];

/** org-a 的 owner，也是 `a-*` 行的 owner：组织内个人资源用例的「本人」。 */
export const ORG_A_OWNER: ActorContext = {
  kind: "user",
  userId: "u1",
  activeOrganizationId: "org-a",
  memberships: [{ organizationId: "org-a", role: "owner" }],
};

/** org-a 的普通成员：组织资源可见，但看不到同组织 owner 名下的个人资源。 */
export const ORG_A_MEMBER: ActorContext = {
  kind: "user",
  userId: "u2",
  activeOrganizationId: "org-a",
  memberships: [{ organizationId: "org-a", role: "member" }],
};

/** 同时是 org-a 成员、但当前组织是 org-b：谓词只认当前组织，这个身份是「跨组织不串」的探针。 */
export const ORG_B_ADMIN: ActorContext = {
  kind: "user",
  userId: "u4",
  activeOrganizationId: "org-b",
  memberships: [
    { organizationId: "org-a", role: "member" },
    { organizationId: "org-b", role: "admin" },
  ],
};

/** 三个 fixture 组织以外的成员：私有行一行都看不到，只剩公开受众。 */
export const OUTSIDE_MEMBER: ActorContext = {
  kind: "user",
  userId: "u5",
  activeOrganizationId: "org-d",
  memberships: [{ organizationId: "org-d", role: "member" }],
};

/** 系统管理员：`bypass` 跳过归属与公开判定。 */
export const SUPER_ADMIN: ActorContext = {
  kind: "user",
  userId: "u9",
  systemRole: "super-admin",
  memberships: [],
};

/** 一次查询构造的记录：SQL 由被测实现真实生成，替身只负责截获。 */
export interface RecordedQuery {
  readonly table: unknown;
  where?: SQL;
  /** `count` 走 `select({ value: count() })`：投影原文留着，断言它是聚合而不是全量行。 */
  projection?: Record<string, SQL>;
  readonly orderBy: SQL[];
  limit?: number;
  offset?: number;
}

/** 生产代码 `await` 的链式查询对象。 */
interface RecordingBuilder {
  where(condition?: SQL): RecordingBuilder;
  $dynamic(): RecordingBuilder;
  orderBy(...order: SQL[]): RecordingBuilder;
  limit(value: number): RecordingBuilder;
  offset(value: number): RecordingBuilder;
  then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown): Promise<unknown>;
}

const dialect = new PgDialect();

/** 把 Drizzle 构造出的 SQL 还原成可断言的文本与参数（与仓库既有 DB 用例同一做法）。 */
export function render(statement: SQL): { sql: string; params: readonly unknown[] } {
  const query = dialect.sqlToQuery(statement);
  return { sql: query.sql, params: query.params };
}

/** 取记录到的 WHERE；缺失说明实现根本没下推授权条件。 */
export function whereOf(recorded: RecordedQuery): SQL {
  if (recorded.where === undefined) throw new Error("记录到的查询没有任何 WHERE 条件");
  return recorded.where;
}

/**
 * 把 Drizzle 行（TS 属性名为键）按表声明转成 SQL 列名为键。
 *
 * 真实数据库按列名返回结果、Drizzle 再映射成属性名；替身直接给出映射后的行，这里补一次逆映射，
 * 让按列名取值的 `rowSatisfiesPredicate` 能在同一行上求值。
 */
function toSqlRow(table: unknown, row: ProbeRow): Record<string, unknown> {
  const columns = getTableColumns(table as PgTable);
  const source: Record<string, unknown> = row;
  const mapped: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(columns)) {
    if (key in source) mapped[column.name] = source[key];
  }
  return mapped;
}

/** 记录查询构造、并按 WHERE + OFFSET / LIMIT 回答的 DB 句柄替身。 */
function createRecordingDatabase(rows: readonly ProbeRow[]): {
  readonly database: AccessControlDatabase;
  readonly queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const database = {
    select: (projection?: Record<string, SQL>) => ({
      from: (table: unknown) => {
        const recorded: RecordedQuery = { table, orderBy: [] };
        if (projection !== undefined) recorded.projection = projection;
        queries.push(recorded);

        const builder: RecordingBuilder = {
          where: (condition) => {
            recorded.where = condition;
            return builder;
          },
          $dynamic: () => builder,
          orderBy: (...order) => {
            recorded.orderBy.push(...order);
            return builder;
          },
          limit: (value) => {
            recorded.limit = value;
            return builder;
          },
          offset: (value) => {
            recorded.offset = value;
            return builder;
          },
          // biome-ignore lint/suspicious/noThenProperty: 生产代码把链式对象直接 await，替身必须真的可 await——这正是它要复刻的行为，不是意外。
          then: (resolve, reject) => {
            // 求值推迟到 await：WHERE 在 `from()` 之后才被传进来。
            const offset = recorded.offset ?? 0;
            const end = recorded.limit === undefined ? undefined : offset + recorded.limit;
            const matched = rows.filter((row) => rowSatisfiesPredicate(recorded.where, toSqlRow(table, row)));
            const page = matched.slice(offset, end);
            return Promise.resolve(projection === undefined ? page : [{ value: page.length }]).then(resolve, reject);
          },
        };
        return builder;
      },
    }),
  } as unknown as AccessControlDatabase;

  return { database, queries };
}

/** 装配被测实现：真实 suite（同一个资源注册喂给查询与范围 Store）+ 记录型 DB 句柄。 */
export function createHarness() {
  const { database, queries } = createRecordingDatabase(PROBE_ROWS);
  return { suite: createDrizzleAccessControl<ProbeStorage>({ database, bindings: PROBE_BINDINGS }), queries };
}

/** 列表入参：表与列固定，用例只给出与本次断言相关的部分。 */
export function listInput(input: {
  access: ResourceQueryConstraint;
  resourceType?: string;
  businessWhere?: readonly SQL[];
  businessOrder?: readonly SQL[];
  limit?: number;
  offset?: number;
}) {
  return {
    resourceType: ORGANIZATION_RESOURCE_TYPE,
    table: probeTable,
    columns: probeColumns,
    ...input,
  };
}

/** 行的业务 id 序列：断言「查到了哪些行」比断言整行更贴近授权语义。 */
export function ids(items: readonly { readonly id: string }[]): readonly string[] {
  return items.map((item) => item.id);
}
