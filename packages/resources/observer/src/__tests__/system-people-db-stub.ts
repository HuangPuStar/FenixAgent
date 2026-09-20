// 人员树测试共用的存储替身与 SQL 片段读取助手（仓储用例与 service 用例各取所需）。
//
// 替身只实现本包仓储用到的那一段 select 链（`select/from/where/orderBy`），并且**不解释** WHERE：
// 它按 WHERE 携带的绑定参数反查组织 id 再返回该组织的行。替身里自己实现一份行过滤只能证明替身自己的
// 过滤是对的（假覆盖）；而「按调用方给的组织取行」反过来钉住了组织谓词真的进了 SQL——多租户隔离断言
// 必须落到绑定值上，否则把 organizationId 写成常量也能通过列名断言。
//
// 为什么读取助手与 `@fenix/resource-prod-view` 的各留一份：它们依赖 Drizzle `SQL` chunk 树的内部形状，
// 抽到公共测试包会让任一侧的 Drizzle 升级都牵动其余包；各包对「下推」的断言意图也不同。
// 跨包 import 对方 `__tests__` 又被 §1.3 的公开出口约束禁止（只能经包根 / `/server` / `/web`）。

import type { DbStub } from "@fenix/platform-sdk/testing";
import type { SystemPeopleAgentRow } from "../server/repositories/system-people-repository";

/** 人员树行的最小夹具；只列服务与界面真正消费的列，未列出的按建表默认值补 null。 */
export function systemPeopleAgentRow(overrides: Partial<SystemPeopleAgentRow> = {}): SystemPeopleAgentRow {
  return {
    id: "agent-1",
    userId: "user-1",
    name: "代码助手",
    description: null,
    machineId: null,
    engineType: null,
    ...overrides,
  };
}

/** 人员树仓储替身：按组织返回行，同时记录投影、WHERE 与排序条件供断言。 */
export interface PeopleTreeDbStub {
  readonly db: DbStub;
  /** `select()` 收到的投影映射，按调用顺序。 */
  readonly projections: Record<string, unknown>[];
  /** `where()` 收到的条件，按调用顺序。 */
  readonly whereClauses: unknown[];
  /** `orderBy()` 收到的排序键，按调用顺序。 */
  readonly orderByClauses: unknown[][];
}

/**
 * 构造 `agent_config` 归属查询的链式替身；`rowsByOrganization` 是各组织的存储内容。
 *
 * 未登记的组织返回空数组而不是抛错：组织的智能体集合本来就可能为空，抛错会把「空组织」这一合法状态
 * 变成用例的构造错误。
 */
export function createPeopleTreeDbStub(rowsByOrganization: Record<string, SystemPeopleAgentRow[]>): PeopleTreeDbStub {
  const projections: Record<string, unknown>[] = [];
  const whereClauses: unknown[] = [];
  const orderByClauses: unknown[][] = [];

  const db: DbStub = {
    select: (projection: Record<string, unknown>) => {
      projections.push(projection);
      return {
        from: () => ({
          where: (clause: unknown) => {
            whereClauses.push(clause);
            return {
              orderBy: async (...keys: unknown[]) => {
                orderByClauses.push(keys);
                const organizationId = collectParamValues(clause)[0];
                return organizationId ? (rowsByOrganization[organizationId] ?? []) : [];
              },
            };
          },
        }),
      };
    },
  };

  return { db, projections, whereClauses, orderByClauses };
}

/**
 * 摊平 Drizzle `SQL` chunk 树收集列名。
 *
 * 不能对整个 `SQL` 做 `JSON.stringify`（表与列互相引用，会抛循环结构错误），因此按 chunk 树递归取
 * 叶子列节点的名字（Drizzle 的列节点同时带 `name` / `dataType` / `columnType`）。
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
 * 列名只能证明「谓词下推了某一列」，参数值才证明「用的是调用方给的那个组织」。
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
