/**
 * 发布顺序的逻辑时钟。
 *
 * 两次发布可能落在同一毫秒里，而本模块的每一条排序规则（版本历史、latest 回退、「最新可见版本」判定）
 * 都依赖「后发布的必然排在后面」。因此候选时刻若不**严格大于**该包已记录的最大时刻，就推进到 `max + 1ms`。
 *
 * 源项目把这条规则写成 `monotonicInstant`，此处保持同名同义。
 */

/**
 * 把候选时刻推进到严格大于 `previous` 的时刻。
 *
 * `previous` 为 NULL（该包尚无版本）或候选更大时原样返回；否则返回 `previous + 1ms`。刻意用 `>` 而不是
 * `>=`：源项目的教训是「恢复（restore）也必须算一次新发布」，用 `>=` 会让恢复后的 `published_at` 原地不动，
 * 从而无法越过当前最新版本、也就无法重新成为 latest（源项目 `tests/catalog/service.test.ts:444-451`）。
 */
export function nextMonotonicInstant(candidate: Date, previous: Date | null): Date {
  if (previous === null || candidate.getTime() > previous.getTime()) return candidate;
  return new Date(previous.getTime() + 1);
}
