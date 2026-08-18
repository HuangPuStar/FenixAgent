// /web/environments/:id/fs/* —— 文件系统操作（收敛无分支，W5b，P1-7b）
// 路由层只做协议接入（认证、参数提取、multipart 解析）与统一错误映射；
// 本地/远程执行收敛到 AgentFileService 门面（docs/arch/12-files.md §2），
// 不再出现 if (machineId) 双分支。错误码统一为 §2.4 契约表：
// 400 validation_error / 404 not_found / 413 payload_too_large /
// 422 config_error / 429 busy(+Retry-After) / 503 file_service_unavailable。

import Elysia from "elysia";
import { type AuthContext, authGuardPlugin } from "../../plugins/auth";
import {
  BatchDeleteRequestSchema,
  BatchDeleteResponseSchema,
  DeleteFileResponseSchema,
  FileContentSchema,
  FileListResponseSchema,
  FileUploadResponseSchema,
  FileWriteResultSchema,
  MkdirRequestSchema,
  MkdirResponseSchema,
  RenameRequestSchema,
  RenameResponseSchema,
  TreeResponseSchema,
  WriteFileRequestSchema,
} from "../../schemas/file.schema";
import { gate, normalizeUploadRelativePath } from "../../services/agent-file-service";
import {
  type FileAuthContext,
  FileServiceError,
  type FileWriteOptions,
  type ReadMode,
} from "../../services/file-types";
import { computeListFingerprint, computeReadFingerprint, computeTreeFingerprint } from "../../services/workspace-fs";

const app = new Elysia({ name: "web-fs", prefix: "/environments" }).use(authGuardPlugin).model({
  "tree-response": TreeResponseSchema,
  "file-list-response": FileListResponseSchema,
  "file-content": FileContentSchema,
  "file-upload-response": FileUploadResponseSchema,
  "file-write-result": FileWriteResultSchema,
  "write-file-request": WriteFileRequestSchema,
  "delete-file-response": DeleteFileResponseSchema,
  "rename-request": RenameRequestSchema,
  "rename-response": RenameResponseSchema,
  "mkdir-request": MkdirRequestSchema,
  "mkdir-response": MkdirResponseSchema,
  "batch-delete-request": BatchDeleteRequestSchema,
  "batch-delete-response": BatchDeleteResponseSchema,
});

// ── 公共辅助 ────────────────────────────────────────────────────

/** 由已认证上下文构造门面认证上下文：actorId=userId、source=user
 * （写操作审计字段契约先行，P2-18 落地时前端可传 instanceId/source）。 */
function fileAuthContext(authCtx: AuthContext, user: { id: string }): FileAuthContext {
  return {
    organizationId: authCtx.organizationId,
    userId: user.id,
    role: authCtx.role,
    actorId: user.id,
    source: "user",
  };
}

/** FileServiceError → 统一错误响应参数（§2.4 错误码表）；busy 附 Retry-After: 1
 * （瞬时容量问题，调用方按该头退避，不得自行重试）。409 version_conflict 附带
 * currentVersion（§4.4 覆盖可感知性：当前 ETag/mtime 供消费者提示与重试）。
 * 非门面错误返回 null（调用方重新抛出，交由全局错误处理，不吞未预期异常；
 * 诊断日志在门面内已保留）。 */
function toFileError(err: unknown): {
  status: number;
  body: { error: { type: string; message: string }; currentVersion?: { etag: string; mtimeMs: number; size: number } };
  retryAfter?: string;
} | null {
  if (!(err instanceof FileServiceError)) return null;
  return {
    status: err.statusCode,
    body: {
      error: { type: err.type, message: err.message },
      ...(err.currentVersion ? { currentVersion: err.currentVersion } : {}),
    },
    retryAfter: err.type === "busy" ? "1" : undefined,
  };
}

/** busy 响应：429 + Retry-After: 1。Elysia 的 error() 无法附加自定义头，
 * 此处用独立 Response 构造。 */
function busyErrorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Retry-After": "1" },
  });
}

// ── 写端点 op_id / If-Match 契约（W12b，§7.2 幂等 + §4.4 条件写）──

/** 写端点统一选项解析：X-File-Op-Id（幂等键）+ If-Match（读时 ETag，条件写）。
 *  两者均可选；都未提供时返回 undefined（行为与现状完全一致）。 */
function writeOptionsFrom(headers: Record<string, string | undefined>): FileWriteOptions | undefined {
  const opId = headers["x-file-op-id"];
  const ifMatch = headers["if-match"];
  if (!opId && !ifMatch) return;
  return { ...(opId ? { opId } : {}), ...(ifMatch ? { ifMatch } : {}) };
}

/** 响应回显 op_id（§7.2 契约：成功与错误响应均原样回显，消费者据此识别幂等重试；
 *  未携带 X-File-Op-Id 时响应与现状完全一致）。const 类型参数保留字面量类型，
 *  使返回结构能匹配 response schema 的 literal 字段（success/ok）。 */
function withOpId<const T extends object>(payload: T, opId: string | undefined): T | (T & { op_id: string }) {
  return opId ? { ...payload, op_id: opId } : payload;
}

/** 写端点统一错误响应：FileServiceError → 统一错误码 + op_id 回显；busy 附 Retry-After；
 *  非门面错误重新抛出（诊断日志在门面内已保留）。 */
function writeErrorResponse(
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
function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
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
function conditionalResponse(
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

// GET /:id/fs/tree — 递归扫描 workspace 树（黑名单过滤）
app.get(
  "/:id/fs/tree",
  async ({ store, params, headers, set, error }) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    try {
      const result = await gate(params.id, fileAuthContext(authCtx, user)).tree();
      // 树指纹：路径 hash + max(mtime) + 路径数；mtimes 缺失（远程弱指纹）时退化为路径 hash
      const etag = computeTreeFingerprint(result.paths, result.mtimes);
      return conditionalResponse(set, etag, headers["if-none-match"], () => ({ success: true, data: result }));
    } catch (e) {
      const fe = toFileError(e);
      if (!fe) throw e;
      return fe.retryAfter !== undefined ? busyErrorResponse(fe.status, fe.body) : error(fe.status, fe.body);
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["FS"],
      summary: "获取 workspace 文件树",
      description: "递归返回整个 workspace 目录的文件与目录路径（黑名单过滤），用于构建完整文件树。",
    },
  },
);

// GET /:id/fs — 列目录
app.get(
  "/:id/fs",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + 错误分支组合下类型推断不稳定
  async ({ store, params, query, headers, set, error }: any) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    // query path 缺失或为空串时默认工作区根（与历史行为一致；空串对列目录无意义）
    const rawPath = (query as Record<string, string | undefined>)?.path;
    const queryPath = rawPath === undefined || rawPath === "" ? "." : rawPath;
    try {
      const entries = await gate(params.id, fileAuthContext(authCtx, user)).list(queryPath);
      // 目录条目指纹：hash(name+type+size+modifiedAt)；modifiedAt 全 0（远程弱指纹）退化为 hash(name+type+size)
      const etag = computeListFingerprint(entries);
      return conditionalResponse(set, etag, headers["if-none-match"], () => ({ success: true, data: { entries } }));
    } catch (e) {
      const fe = toFileError(e);
      if (!fe) throw e;
      return fe.retryAfter !== undefined ? busyErrorResponse(fe.status, fe.body) : error(fe.status, fe.body);
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["FS"],
      summary: "获取 workspace 目录列表",
      description: "返回指定环境 workspace 目录下的文件和目录列表（黑名单过滤）。",
    },
  },
);

// GET /:id/fs/* — 读文件
app.get(
  "/:id/fs/*",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + 错误分支组合下类型推断不稳定
  async ({ store, params, query, headers, error, set }: any) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    // biome-ignore lint/suspicious/noExplicitAny: Elysia splat param not typed
    let rawFilePath = (params as any)["*"] as string;
    // 浏览器发送的 URL 中非 ASCII 字符会被 percent-encode，Elysia 的 memoirist 路由
    // 在某些版本下可能不会自动解码通配符 * 的值，这里做一层安全的 decodeURIComponent
    // 兜底。如果已解码则 catch 保留原值（解码后的中文会 throw URIError）。
    try {
      rawFilePath = decodeURIComponent(rawFilePath);
    } catch {
      // 已经解码，直接使用
    }
    // mode 显式（§7.8 移除静默回退）：未传时保留 preview 兼容（true → binary）；
    // 两者都未提供 → auto（与历史默认一致）。非法 mode 显式拒绝，不猜测语义。
    const queryRecord = query as Record<string, string | undefined>;
    const preview = queryRecord?.preview === "true";
    const rawMode = queryRecord?.mode;
    let mode: ReadMode;
    if (rawMode === undefined) mode = preview ? "binary" : "auto";
    else if (rawMode === "text" || rawMode === "binary" || rawMode === "auto") mode = rawMode;
    else {
      return error(400, {
        error: { type: "validation_error", message: "mode must be one of: text, binary, auto" },
      });
    }
    try {
      const result = await gate(params.id, fileAuthContext(authCtx, user)).read(rawFilePath, mode);
      // read 指纹：size-mtimeMs；远程无 mtime → size-only 弱指纹（弱指纹注释见 computeReadFingerprint）
      const etag = computeReadFingerprint(result.size, result.mtimeMs);
      set.headers.ETag = etag;
      set.headers["Cache-Control"] = "no-cache";
      if (etagMatches(headers["if-none-match"], etag)) {
        // 304：丢弃未消费的本地读流（createReadStream 已打开 fd），避免 fd 泄漏
        if ("stream" in result) (result.stream as { destroy?: () => void }).destroy?.();
        return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-cache" } });
      }
      if (result.type === "text") {
        return {
          success: true,
          data: {
            name: result.name,
            path: result.path,
            content: result.content,
            size: result.size,
            encoding: result.encoding,
            type: result.type,
          },
        };
      }
      // 二进制流响应（preview 或下载，含 §7.8 auto 回退 binary）：一律显式标记
      // X-File-Type: binary——消费者据此区分「JSON 文本响应」与「二进制流响应」；
      // preview 流与 auto 回退流无法经此头区分（区分回退来源需机器端错误码，二期）
      set.headers["X-File-Type"] = "binary";
      if (preview) {
        set.headers["Content-Type"] = result.mimeType || "application/octet-stream";
        set.headers["Content-Security-Policy"] =
          "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' blob:; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * blob:; connect-src *";
        // biome-ignore lint/suspicious/noExplicitAny: NodeJS.ReadableStream 与 Response body 类型不匹配（历史惯例）
        return new Response(result.stream as any);
      }
      // 二进制下载：中文文件名 RFC 5987 编码
      const hasNonAscii = [...result.name].some((c) => c.charCodeAt(0) > 127);
      const encodedFileName = encodeURIComponent(result.name);
      const contentDisp = hasNonAscii
        ? `attachment; filename*=UTF-8''${encodedFileName}`
        : `attachment; filename="${result.name}"`;
      set.headers["Content-Disposition"] = contentDisp;
      set.headers["Content-Type"] = "application/octet-stream";
      // biome-ignore lint/suspicious/noExplicitAny: NodeJS.ReadableStream 与 Response body 类型不匹配（历史惯例）
      return new Response(result.stream as any);
    } catch (e) {
      const fe = toFileError(e);
      if (!fe) throw e;
      return fe.retryAfter !== undefined ? busyErrorResponse(fe.status, fe.body) : error(fe.status, fe.body);
    }
  },
  {
    sessionAuth: true,
    response: "file-content",
    detail: {
      tags: ["FS"],
      summary: "读取 workspace 文件内容",
      description:
        "读取指定文件。mode 显式指定 text/binary/auto（默认 auto，preview=true 兼容为 binary 流预览）；文本返回 JSON，二进制返回文件流。",
    },
  },
);

// POST /:id/fs/* — 上传文件
app.post(
  "/:id/fs/*",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + 错误分支组合下类型推断不稳定
  async ({ store, params, request, headers, error }: any) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    const options = writeOptionsFrom(headers as Record<string, string | undefined>);
    const opId = options?.opId;
    // biome-ignore lint/suspicious/noExplicitAny: Elysia splat param not typed
    let rawDirPath = ((params as any)["*"] as string) || "";
    try {
      rawDirPath = decodeURIComponent(rawDirPath);
    } catch {
      /* 已解码 */
    }

    const formData = await request.formData();
    const files = formData.getAll("files") as File[];
    if (!files || files.length === 0)
      return error(400, withOpId({ error: { type: "validation_error", message: "No files provided" } }, opId));

    // 解析相对路径数组（文件夹上传时由前端传入）
    const rawPaths = formData.get("relativePaths");
    let relativePaths: string[] = [];
    if (rawPaths && typeof rawPaths === "string") {
      try {
        const parsed: unknown = JSON.parse(rawPaths);
        // 只接受数组；非数组 JSON（如 "null"/数字/字符串）视为未提供，
        // 否则后续 for..of 对 null/数字迭代会抛 TypeError 变成 500。
        relativePaths = Array.isArray(parsed) ? (parsed as string[]) : [];
      } catch {
        relativePaths = [];
      }
    }

    // 整批校验 relativePaths 的全部条目（W2 语义随迁）：门面只校验与文件
    // 一一对应的条目，未消费的多余条目若非法也必须整批拒绝（避免"部分文件
    // 已落盘后才发现路径越界"）；规则单一来源仍是门面导出的校验函数。
    for (const relPath of relativePaths) {
      if (normalizeUploadRelativePath(relPath) === null) {
        return error(
          400,
          withOpId(
            {
              error: {
                type: "validation_error",
                message: "Invalid relativePath: must be a relative path without '..' segments or control characters",
              },
            },
            opId,
          ),
        );
      }
    }

    try {
      const inputs = await Promise.all(
        files.map(async (file, i) => ({
          // Bun 对空 multipart filename 返回 undefined（而非空串），兜底为空串
          // 使门面的空文件名校验（400）生效，避免 undefined.trim() 抛 TypeError 变 500
          name: file.name ?? "",
          content: Buffer.from(await file.arrayBuffer()),
          // 数组短于文件列表时缺失项为 undefined → 门面回退 file.name
          relativePath: relativePaths[i],
        })),
      );
      const result = await gate(params.id, fileAuthContext(authCtx, user)).upload(rawDirPath, inputs, options);
      return withOpId({ success: true, data: result }, opId);
    } catch (e) {
      return writeErrorResponse(e, opId, error);
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["FS"],
      summary: "上传文件",
      description: "向 workspace 指定目录上传一个或多个文件；支持通过 relativePaths 保留文件夹层级。",
    },
  },
);

// PUT /:id/fs/* — 写入文件内容
app.put(
  "/:id/fs/*",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + 错误分支组合下类型推断不稳定
  async ({ store, params, body, headers, error }: any) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    const options = writeOptionsFrom(headers as Record<string, string | undefined>);
    const opId = options?.opId;
    // biome-ignore lint/suspicious/noExplicitAny: Elysia splat param not typed
    let rawFilePath = (params as any)["*"] as string;
    try {
      rawFilePath = decodeURIComponent(rawFilePath);
    } catch {
      /* 已解码 */
    }

    const b = body as { content?: string };
    if (typeof b.content !== "string")
      return error(400, withOpId({ error: { type: "validation_error", message: "content field required" } }, opId));

    if (b.content.length > 100 * 1024 * 1024)
      return error(
        413,
        withOpId({ error: { type: "validation_error", message: "Content exceeds 100MB limit" } }, opId),
      );

    try {
      const result = await gate(params.id, fileAuthContext(authCtx, user)).write(rawFilePath, b.content, options);
      return withOpId({ success: true, data: result }, opId);
    } catch (e) {
      return writeErrorResponse(e, opId, error);
    }
  },
  {
    sessionAuth: true,
    body: "write-file-request",
    response: "file-write-result",
    detail: {
      tags: ["FS"],
      summary: "写入文件内容",
      description: "将文本内容写入 workspace 任意路径文件。",
    },
  },
);

// DELETE /:id/fs/* — 删除文件
app.delete(
  "/:id/fs/*",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + 错误分支组合下类型推断不稳定
  async ({ store, params, headers, error }: any) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    const options = writeOptionsFrom(headers as Record<string, string | undefined>);
    const opId = options?.opId;
    // biome-ignore lint/suspicious/noExplicitAny: Elysia splat param not typed
    let rawFilePath = (params as any)["*"] as string;
    try {
      rawFilePath = decodeURIComponent(rawFilePath);
    } catch {
      /* 已解码 */
    }

    try {
      await gate(params.id, fileAuthContext(authCtx, user)).delete(rawFilePath, options);
      return withOpId({ success: true, data: { ok: true } }, opId);
    } catch (e) {
      // 与其他写端点不同，此处内联错误映射而非复用 writeErrorResponse：
      // Elysia 的 delete 方法强制 InlineHandler（无 NonMacro 分支），handler 返回
      // `Promise<Response | 字面量>` 时仅内联 error() 能通过类型推断（Elysia 3.x 类型怪癖）
      const fe = toFileError(e);
      if (!fe) throw e;
      const body = withOpId(fe.body, opId);
      return fe.retryAfter !== undefined ? busyErrorResponse(fe.status, body) : error(fe.status, body);
    }
  },
  {
    sessionAuth: true,
    response: "delete-file-response",
    detail: {
      tags: ["FS"],
      summary: "删除文件",
      description: "删除 workspace 任意路径的文件或目录（目录将递归删除）。",
    },
  },
);

// POST /:id/fs/mkdir — 创建目录
app.post(
  "/:id/fs/mkdir",
  async ({ store, params, body, headers, error }) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    const options = writeOptionsFrom(headers as Record<string, string | undefined>);
    const opId = options?.opId;
    const { path } = body as { path: string };
    try {
      await gate(params.id, fileAuthContext(authCtx, user)).mkdir(path, options);
      return withOpId({ success: true, data: { path } }, opId);
    } catch (e) {
      return writeErrorResponse(e, opId, error);
    }
  },
  {
    sessionAuth: true,
    body: "mkdir-request",
    detail: {
      tags: ["FS"],
      summary: "创建目录",
      description: "在 workspace 任意路径创建新目录。",
    },
  },
);

// POST /:id/fs/rename — 重命名/移动
app.post(
  "/:id/fs/rename",
  async ({ store, params, body, headers, error }) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    const options = writeOptionsFrom(headers as Record<string, string | undefined>);
    const opId = options?.opId;
    const { oldPath, newPath } = body as { oldPath: string; newPath: string };
    try {
      await gate(params.id, fileAuthContext(authCtx, user)).rename(oldPath, newPath, options);
      return withOpId({ success: true, data: { oldPath, newPath } }, opId);
    } catch (e) {
      return writeErrorResponse(e, opId, error);
    }
  },
  {
    sessionAuth: true,
    body: "rename-request",
    detail: {
      tags: ["FS"],
      summary: "重命名文件或目录",
      description: "在 workspace 内重命名或移动文件/目录。",
    },
  },
);

// DELETE /:id/fs/batch — 批量删除
app.delete(
  "/:id/fs/batch",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + 错误分支组合下类型推断不稳定
  async ({ store, params, body, headers, error }: any) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    // opId/ifMatch 对整批生效：单条 If-Match 不匹配的路径进 failed 列表（尽量删除
    // + 分别报告契约），op_id 在整批成功/错误响应中回显（§7.2 幂等重试标识）
    const options = writeOptionsFrom(headers as Record<string, string | undefined>);
    const opId = options?.opId;
    const { paths } = body as { paths: string[] };
    const deleted: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];

    // 逐条执行并收集失败：批量删除的契约是"尽量删除 + 分别报告"，单条失败不中断整批。
    // 门面已把每条的诊断写入服务端日志，此处只透传面向用户的 message。
    const fs = gate(params.id, fileAuthContext(authCtx, user));
    try {
      for (const p of paths) {
        try {
          await fs.delete(p, options);
          deleted.push(p);
        } catch (e) {
          failed.push({ path: p, error: e instanceof Error ? e.message : "Unknown error" });
        }
      }
      return withOpId({ success: true, data: { deleted, failed } }, opId);
    } catch (e) {
      return writeErrorResponse(e, opId, error);
    }
  },
  {
    sessionAuth: true,
    body: "batch-delete-request",
    detail: {
      tags: ["FS"],
      summary: "批量删除文件或目录",
      description: "批量删除 workspace 内指定路径的文件或目录（目录将递归删除），并分别返回成功与失败结果。",
    },
  },
);

// GET /:id/fs/download-zip — 打包下载目录
app.get(
  "/:id/fs/download-zip",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + 错误分支组合下类型推断不稳定
  async ({ store, params, query, error, set }: any) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    const path = (query as Record<string, string | undefined>)?.path;
    if (!path) return error(400, { error: { type: "validation_error", message: "path query parameter required" } });

    try {
      const stream = await gate(params.id, fileAuthContext(authCtx, user)).downloadZip(path);
      const dirName = path.split("/").filter(Boolean).pop() || "download";
      set.headers["Content-Type"] = "application/zip";
      set.headers["Content-Disposition"] = `attachment; filename="${dirName}.zip"`;
      // biome-ignore lint/suspicious/noExplicitAny: NodeJS.ReadableStream 与 Response body 类型不匹配（历史惯例）
      return new Response(stream as any);
    } catch (e) {
      const fe = toFileError(e);
      if (!fe) throw e;
      return fe.retryAfter !== undefined ? busyErrorResponse(fe.status, fe.body) : error(fe.status, fe.body);
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["FS"],
      summary: "下载目录压缩包",
      description:
        "将 workspace 内指定目录打包为 zip 文件并直接返回下载流；远程环境支持取决于机器端 zip 能力（未就绪时返回 501）。",
    },
  },
);

export default app;
