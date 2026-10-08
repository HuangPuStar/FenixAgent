/**
 * 可见集合查询链的替身与条件快照。
 *
 * 知识库仓储的「可见集合」由三件事共同定义：WHERE 条件（`visibleWhere`：本组织条件或整段省略）、排序
 * （`visibleOrder`）与分页（`LIMIT/OFFSET`）。它们都必须挂在**同一条** SQL 上，且列表与计数共用同一份
 * 条件——这些结论只能在 Drizzle 的查询链上断言，因此本文件提供两件东西：按链式形状接住 `where` /
 * `orderBy` / `$dynamic` / `limit` / `offset` 的替身，以及从条件树里读出「哪一列、绑了哪个值」的快照。
 *
 * 与 `../src/server/repositories/knowledge-base.ts` 的分工：仓储负责把 `includeGlobal` 翻译成条件，
 * 本文件只记录并摊平它，不解释、不代答。
 */

/** 分页查询链替身记录下来的调用参数：`where` 存的是交给 Drizzle 的可见条件原样。 */
export interface CapturedVisibleQuery {
  where?: unknown;
  limit?: number;
  offset?: number;
  orderBy: unknown[];
}

/**
 * `listVisible` 的查询链替身：`where` → `orderBy` → `$dynamic()` → 按需追加 LIMIT / OFFSET，全部挂在
 * 同一条链上。
 *
 * 用 thenable 对象而不是 Promise：`await` 时要拿到行数据，链式调用时又要记录下推的参数——两者同时成立
 * 才能断言"分页真的进了 SQL"，而不是查完之后被截取。链的形状本身也是断言：`limit` / `offset` 只存在于
 * `orderBy` 之后的构建器上，实现若把分页挪到别的查询（或在 `where` 之前截取）就拿不到这一层。
 */
export function pagedList(rows: unknown[], captured: CapturedVisibleQuery) {
  const result = Promise.resolve(rows);
  const builder = Object.assign(result, {
    limit: (value: number) => {
      captured.limit = value;
      return builder;
    },
    offset: (value: number) => {
      captured.offset = value;
      return builder;
    },
  });
  return {
    from: () => ({
      where: (condition: unknown) => {
        captured.where = condition;
        return {
          orderBy: (...args: unknown[]) => {
            captured.orderBy = args;
            return { $dynamic: () => builder };
          },
        };
      },
    }),
  };
}

/** 列节点与绑定值节点的识别判据（与 `@fenix/platform-sdk` 谓词求值器同一套：列三要素齐备，值带 encoder）。 */
function isColumnNode(chunk: unknown): chunk is { name: string } {
  const candidate = chunk as { name?: unknown; dataType?: unknown; columnType?: unknown };
  return typeof candidate.name === "string" && candidate.dataType !== undefined && candidate.columnType !== undefined;
}

function isBoundValueNode(chunk: unknown): chunk is { value: unknown } {
  return chunk !== null && typeof chunk === "object" && "encoder" in chunk && "value" in chunk;
}

/**
 * 摊平 Drizzle 条件树，取出条件里出现的**列名**与**绑定值**。
 *
 * 为什么不能直接断言 `where` 被调用过：可见条件就是这个函数要看的东西——「本组织」是
 * `organization_id = <actor 的组织>`，「并入全局」是**不加条件**（全表）。只有把列名与绑定值取出来，
 * 才能区分这两种情形；直接 `JSON.stringify` 不行（表与列互相引用，会抛循环结构错误），因此按 chunk
 * 递归取叶子。
 */
export function describeCondition(condition: unknown): { columns: string[]; values: unknown[] } {
  const found: { columns: string[]; values: unknown[] } = { columns: [], values: [] };
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const chunks = (node as { queryChunks?: readonly unknown[] }).queryChunks;
    if (!Array.isArray(chunks)) return;
    for (const chunk of chunks) {
      if (isColumnNode(chunk)) found.columns.push(chunk.name);
      else if (isBoundValueNode(chunk)) found.values.push(chunk.value);
      else walk(chunk);
    }
  };
  walk(condition);
  return found;
}
