import { FileServiceError, type FileWriteOptions, type UploadFailureDetails } from "../services/file-types";
// ── 公共辅助 ────────────────────────────────────────────────────

/** FileServiceError → 统一错误响应参数（§2.4 错误码表）；busy 附 Retry-After: 1
 * （瞬时容量问题，调用方按该头退避，不得自行重试）。409 version_conflict 附带
 * currentVersion（§4.4 覆盖可感知性：当前 ETag/mtime 供消费者提示与重试）。
 * 非门面错误返回 null（调用方重新抛出，交由全局错误处理，不吞未预期异常；
 * 诊断日志在门面内已保留）。 */
export function toFileError(err: unknown): {
  status: number;
  body: {
    error: { type: string; code?: string; message: string };
    currentVersion?: { etag: string; mtimeMs: number; size: number };
    data?: UploadFailureDetails;
  };
  retryAfter?: string;
} | null {
  if (!(err instanceof FileServiceError)) return null;
  return {
    status: err.statusCode,
    body: {
      error: {
        type: err.type,
        ...(["path_conflict", "version_conflict"].includes(err.type) ? { code: err.type } : {}),
        message: err.message,
      },
      ...(err.details ? { data: err.details } : {}),
      ...(err.currentVersion ? { currentVersion: err.currentVersion } : {}),
    },
    retryAfter: err.type === "busy" ? "1" : undefined,
  };
}

/** busy 响应：429 + Retry-After: 1。Elysia 的 error() 无法附加自定义头，
 * 此处用独立 Response 构造。 */
export function busyErrorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Retry-After": "1" },
  });
}

// ── 写端点 op_id / If-Match 契约（W12b，§7.2 幂等 + §4.4 条件写）──

/** 写端点统一选项解析：X-File-Op-Id（幂等键）+ If-Match（读时 ETag，条件写）。
 *  两者均可选；都未提供时返回 undefined（行为与现状完全一致）。 */
export function writeOptionsFrom(headers: Record<string, string | undefined>): FileWriteOptions | undefined {
  const opId = headers["x-file-op-id"];
  const ifMatch = headers["if-match"];
  if (!opId && !ifMatch) return;
  return { ...(opId ? { opId } : {}), ...(ifMatch ? { ifMatch } : {}) };
}

/** 响应回显 op_id（§7.2 契约：成功与错误响应均原样回显，消费者据此识别幂等重试；
 *  未携带 X-File-Op-Id 时响应与现状完全一致）。const 类型参数保留字面量类型，
 *  使返回结构能匹配 response schema 的 literal 字段（success/ok）。 */
export function withOpId<const T extends object>(payload: T, opId: string | undefined): T | (T & { op_id: string }) {
  return opId ? { ...payload, op_id: opId } : payload;
}

/** 写端点统一错误响应：FileServiceError → 统一错误码 + op_id 回显；busy 附 Retry-After；
 *  非门面错误重新抛出（诊断日志在门面内已保留）。 */
export function writeErrorResponse(
  e: unknown,
  opId: string | undefined,
  errorFn: (status: number, value: unknown) => Response,
): Response {
  const fe = toFileError(e);
  if (!fe) throw e;
  const body = withOpId(fe.body, opId);
  return fe.retryAfter !== undefined ? busyErrorResponse(fe.status, body) : errorFn(fe.status, body);
}

// ── ETag 条件请求（§4.2，W13' 读侧）────────────────────────────

/** If-None-Match 比较（HTTP 条件请求语义）：支持 `*` 与逗号分隔多值列表；
 *  单值弱比较——剥离 `W/` 前缀与引号后按字符串相等判定（`W/"x"` 与 `"x"` 视为命中）。 */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const trimmed = ifNoneMatch.trim();
  if (trimmed === "*") return true;
  const normalize = (v: string) => v.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  return trimmed.split(",").some((part) => normalize(part) === normalize(etag));
}

/** 统一条件请求响应（tree/list/read 共用）：
 *  先执行操作、后比对——304 不省服务端扫描（无状态设计，docs/arch/12-files.md §4.2 诚实边界）。
 *  命中 If-None-Match → 304（无 body，响应头保留 ETag 供客户端更新缓存）；
 *  未命中 → 200 + ETag + Cache-Control: no-cache（文件 API 一律不允许过期复用）。
 *  set 取 Elysia 上下文（headers 值类型为 string|number，与 HTTPHeaders 一致）。 */
export function conditionalResponse(
  set: { headers: Record<string, string | number> },
  etag: string,
  ifNoneMatch: string | undefined,
  payload: () => unknown,
): Response | unknown {
  set.headers.ETag = etag;
  set.headers["Cache-Control"] = "no-cache";
  if (etagMatches(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-cache" } });
  }
  return payload();
}
