/**
 * 控制台端点（`/web/knowledgeBases*`）的响应映射：门面结果 → 既有 `/web/*` 信封。
 *
 * 为什么要单独一个文件：门面把每条动作的结局收敛成 `ok` / 失败分类（见
 * `../../facades/knowledge-result`），协议层不再需要按 `null`、错误文案或 `catch` 反推状态码。分类到
 * 状态码的对应关系只在这里出现一次——迁移前它散在 23 条端点上（同一份 `NOT_FOUND → 404 / 否则 400`
 * 抄了多遍），任何一条抄错都不会有人发现。
 *
 * 分类与状态码的对应沿用迁移前的线上口径：`not-found` → 404、`conflict` → 409、`upstream` → 502、
 * 其余（输入非法、本地动作失败）→ 400。响应体里的 `code` / `message` 一律原样透传门面给出的既有错误码
 * 与文案，本层不改写。
 */

import type { KnowledgeErrorKind, KnowledgeResult } from "../../facades/knowledge-result";

/** 门面失败分类 → HTTP 状态码；本包唯一一份口径。 */
const STATUS_BY_KIND: Record<KnowledgeErrorKind, number> = {
  invalid: 400,
  "not-found": 404,
  conflict: 409,
  failed: 400,
  upstream: 502,
};

/** Elysia 的 `error` 装饰器：按状态码构造响应。 */
export type WebErrorResponder = (status: number, body: unknown) => unknown;

/** `/web/*` 成功信封。 */
export function webData<T>(data: T): { readonly success: true; readonly data: T } {
  return { success: true, data };
}

/** 把门面结果映射成控制台响应：成功走信封，失败按分类选状态码并原样带上既有错误码与文案。 */
export function respondToWeb<T>(result: KnowledgeResult<T>, error: WebErrorResponder): unknown {
  if (result.ok) return webData(result.data);
  return error(STATUS_BY_KIND[result.error.kind], {
    success: false,
    error: { code: result.error.code, message: result.error.message },
  });
}
