import type { DbStub } from "@fenix/platform-sdk/testing";
import type { ProdViewRow } from "@fenix/resource-prod-view/db";

/**
 * `prod_view` 表的 Drizzle 链式替身与配套的 SQL 片段读取助手。
 *
 * 替身只实现本包仓储用到的四段链（`select/from/where/(limit|orderBy)`、
 * `insert/values/returning`、`update/set/where/returning`、`delete/where/returning`），并且**不解释**
 * WHERE 条件——替身里自己实现一份行过滤，只能证明替身自己实现的过滤是对的，属假覆盖。需要断言「组织
 * 谓词真的进了 SQL」时改用 {@link collectColumnNames} / {@link collectParamValues} 摊平 Drizzle 的
 * `SQL` chunk 树：那是真正交给数据库的那份条件。
 *
 * 替身不对任何请求做鉴权或业务判断，它只回答「这条链返回什么行」；行为正确性由被驱动的仓储/服务决定。
 */

/** 固定 Agent 配置 ID：`CreateProdViewSchema.agentId` 要求 uuid，路由用例需要一份合法值。 */
export const AGENT_ID = "11111111-1111-4111-8111-111111111111";

/** `prod_view` 行的最小完整夹具；未列出的列按建表默认值补齐（对齐本包 `db/schema.ts`，§1.7 B11 起表定义归本包）。 */
export function prodViewRow(overrides: Partial<ProdViewRow> = {}): ProdViewRow {
  return {
    id: "pv-1",
    organizationId: "org-1",
    name: "demo",
    description: null,
    agentId: AGENT_ID,
    modulesConfig: {},
    enabled: true,
    createdBy: "user-1",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

/** 仓储替身：记录语句、返回行，并提供「写操作未命中」的开关。 */
export interface ProdViewDbStub {
  readonly db: DbStub;
  /** 替身持有的行，用例可直接增删以摆出存储状态。 */
  readonly store: ProdViewRow[];
  readonly writes: {
    readonly inserts: Record<string, unknown>[];
    readonly updates: Record<string, unknown>[];
    /** `set()` 收到的补丁参数（与 `updates` 同一份，单独取名便于阅读用例意图）。 */
    readonly patches: Record<string, unknown>[];
  };
  /** `select/update/delete` 收到的 WHERE 条件，按调用顺序；断言列名与参数值时用。 */
  readonly whereClauses: unknown[];
  /** 读到了行、写操作却未命中——模拟并发删除，用于覆盖 DELETE_FAILED 分支。 */
  readonly flags: { deleteReturnsEmpty: boolean };
}

/** 构造 `prod_view` 表的链式替身；`rows` 为初始存储内容。 */
export function createProdViewDbStub(rows: ProdViewRow[] = []): ProdViewDbStub {
  const store: ProdViewRow[] = [...rows];
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const whereClauses: unknown[] = [];
  const flags = { deleteReturnsEmpty: false };

  const db: DbStub = {
    select: () => ({
      from: () => ({
        where: (clause: unknown) => {
          whereClauses.push(clause);
          return {
            limit: async () => [...store],
            orderBy: async () => [...store],
          };
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserts.push(values);
        const row = prodViewRow({ ...(values as Partial<ProdViewRow>), id: `pv-${inserts.length}` });
        store.push(row);
        return { returning: async () => [row] };
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return {
          where: (clause: unknown) => {
            whereClauses.push(clause);
            return {
              returning: async () => {
                const current = store[0];
                if (!current) return [];
                const next = { ...current, ...(patch as Partial<ProdViewRow>) };
                store[0] = next;
                return [next];
              },
            };
          },
        };
      },
    }),
    delete: () => ({
      where: (clause: unknown) => {
        whereClauses.push(clause);
        return {
          returning: async () => {
            if (flags.deleteReturnsEmpty) return [];
            const [removed] = store.splice(0, 1);
            return removed ? [{ id: removed.id }] : [];
          },
        };
      },
    }),
  };

  return { db, store, writes: { inserts, updates, patches: updates }, whereClauses, flags };
}

/**
 * 摊平 SQL chunk 树收集列名。
 *
 * 不能对 Drizzle 的 `SQL` 直接 `JSON.stringify`（表与列互相引用，会抛循环结构错误），因此按 chunk 树
 * 递归取叶子列节点的名字。与 `@fenix/resource-mcp`、`@fenix/resource-skill` 的同名助手刻意各自保留
 * 一份：它依赖 Drizzle chunk 的内部形状，各包对「下推」的断言意图也不同；抽到公共测试包会让任一侧的
 * 调整都牵动其余包。
 */
export function collectColumnNames(node: unknown, names: string[] = []): string[] {
  if (node === null || typeof node !== "object") return names;
  const chunks = (node as { queryChunks?: readonly unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) collectColumnNames(chunk, names);
    return names;
  }
  const candidate = node as { name?: unknown; dataType?: unknown; columnType?: unknown };
  if (typeof candidate.name === "string" && candidate.dataType !== undefined && candidate.columnType !== undefined) {
    names.push(candidate.name);
  }
  return names;
}

/**
 * 收集绑定参数的字面值（`Param` 叶子）。
 *
 * 列名只能证明「谓词下推了某一列」，参数值才证明「用的是调用方给的那个组织」——多租户隔离断言必须落到
 * 值上，否则把 `organizationId` 写死成常量也能通过列名断言。
 */
export function collectParamValues(node: unknown, values: string[] = []): string[] {
  if (node === null || typeof node !== "object") return values;
  const chunks = (node as { queryChunks?: readonly unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) collectParamValues(chunk, values);
    return values;
  }
  const candidate = node as { value?: unknown; encoder?: unknown };
  if (candidate.encoder !== undefined && candidate.value !== undefined) {
    values.push(String(candidate.value));
  }
  return values;
}
