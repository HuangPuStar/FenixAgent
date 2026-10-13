// 人员树测试共用的存储替身与 SQL 片段读取助手。
//
// 替身只实现人员树取数用到的那一段 select 链（`select/from/where/orderBy`），并且**不解释** WHERE：
// 它按 WHERE 携带的绑定参数反查组织 id 再返回该组织的行。替身里自己实现一份行过滤只能证明替身自己的
// 过滤是对的（假覆盖）；而「按调用方给的组织取行」反过来钉住了组织谓词真的进了 SQL——多租户隔离断言
// 必须落到绑定值上，否则把 organizationId 写成常量也能通过列名断言。
//
// 行类型直接用 owner（agent-config）的 `AgentConfigOwnershipRow`，不在这里复制一份字段表：投影列的
// 增删由 owner 决定，本包只消费；复制一份会让两侧静默漂移。
//
// 为什么参数读取助手与 `@fenix/resource-prod-view` 的各留一份：它依赖 Drizzle `SQL` chunk 树的内部形状，
// 抽到公共测试包会让任一侧的 Drizzle 升级都牵动其余包；各包对「下推」的断言意图也不同。
// 跨包 import 对方 `__tests__` 又被 §1.3 的公开出口约束禁止（只能经包根 / `/server` / `/web`）。
// 列名 / 排序方向这类**形状**断言随实现（B7 起在 agent-config）搬去 owner 侧，由那边自持一份
// （`@fenix/agent-config` 的 `src/__tests__/`，见其 `fixtures.ts` 的「Drizzle 查询形状断言」段）；
// 本文件只留下构造替身自己需要的那一个助手。

import type { AgentConfigOwnershipRow } from "@fenix/agent-config/server";
import type { DbStub } from "@fenix/platform-sdk/testing";

/** 人员树行的最小夹具；只列服务与界面真正消费的列，未列出的按建表默认值补 null。 */
export function systemPeopleAgentRow(overrides: Partial<AgentConfigOwnershipRow> = {}): AgentConfigOwnershipRow {
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

/** 人员树取数替身：按组织返回行，同时记录投影、WHERE 与排序条件供断言。 */
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
export function createPeopleTreeDbStub(
  rowsByOrganization: Record<string, AgentConfigOwnershipRow[]>,
): PeopleTreeDbStub {
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
 * 收集绑定参数的字面值（`Param` 叶子）；只服务上面的替身——用例经它反查组织后再由替身返回该组织的行。
 *
 * 不导出：SQL 形状断言（列名 / 排序方向）已随实现搬到 owner 侧，本包没有第二个消费者。
 */
function collectParamValues(node: unknown, values: string[] = []): string[] {
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
