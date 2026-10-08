/**
 * 门面动作的结果信封（Facade 层公共契约）。
 *
 * 领域服务把结果与失败混在各自的返回形状里（有的抛、有的返回 `null`、有的返回 `{ success, error }`），
 * 协议层因此只能按 `null`、错误文案或 `catch` 反推该回哪个状态码——同一份判断在多条端点上各写一遍。
 * 门面把每条动作的结局收敛成两个分支：`ok` 带数据，`fail` 带**既有的对外错误码与文案**（逐字保持，
 * 协议层原样放进响应体）以及一个描述传输分类的 {@link KnowledgeErrorKind}，协议层据此选状态码而不再猜。
 *
 * 为什么是 `kind` 而不是直接给 HTTP 数字：Facade 是应用层，不进协议细节；`kind` 是传输中立的分类，
 * 「哪一类对应哪个状态码」这张表留在协议层且只有一份。
 */

/**
 * 失败分类——**只描述本次动作是怎么失败的**，不描述具体原因（原因在 `code` 里）。
 *
 * - `invalid`：输入或前置条件不成立（协议层 400）。
 * - `not-found`：目标不存在，或存在但不可见（协议层 404；两者同码是刻意的，见 `knowledge-access`）。
 * - `conflict`：与既有记录冲突（协议层 409）。
 * - `failed`：本地动作失败（协议层 400，具体 `code` 区分删除/启停/解析/切片等）。
 * - `upstream`：远端 provider 失败（协议层 502）。
 */
export type KnowledgeErrorKind = "invalid" | "not-found" | "conflict" | "failed" | "upstream";

/** 门面失败：`code` / `message` 是对外契约的一部分，`kind` 供协议层选状态码。 */
export interface KnowledgeError {
  readonly kind: KnowledgeErrorKind;
  readonly code: string;
  readonly message: string;
}

/** 门面动作结果。 */
export type KnowledgeResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: KnowledgeError };

/** 成功信封。 */
export function knowledgeOk<T>(data: T): KnowledgeResult<T> {
  return { ok: true, data };
}

/** 失败信封。 */
export function knowledgeFail<T = never>(kind: KnowledgeErrorKind, code: string, message: string): KnowledgeResult<T> {
  return { ok: false, error: { kind, code, message } };
}

/** 统一的「目标不存在」失败：跨组织与不存在同码同文案，避免把资源 ID 变成探测面。 */
export function knowledgeNotFound<T = never>(message: string): KnowledgeResult<T> {
  return knowledgeFail("not-found", "NOT_FOUND", message);
}

/** 远端/provider 失败；`message` 保留上游诊断信息（不含凭据）。 */
export function knowledgeUpstream<T = never>(message: string): KnowledgeResult<T> {
  return knowledgeFail("upstream", "KNOWLEDGE_PROVIDER_ERROR", message);
}
