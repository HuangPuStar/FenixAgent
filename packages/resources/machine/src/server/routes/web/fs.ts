// /web/environments/:id/fs/* —— 文件系统操作（收敛无分支，W5b，P1-7b）
// 路由层只做协议接入（认证、参数提取、multipart 解析）与统一错误映射；环境归属与角色授权在
// machineFileFacade 内完成（§3.2「授权止于 Facade」），本层不再就地转换认证上下文，
// 本地/远程执行收敛到 AgentFileService（docs/arch/12-files.md §2），
// 不再出现 if (machineId) 双分支。错误码统一为 §2.4 契约表：
// 400 validation_error / 404 not_found / 413 payload_too_large /
// 422 config_error / 429 busy(+Retry-After) / 503 file_service_unavailable。

import Elysia from "elysia";
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
} from "../../../schemas/file.schema";
import { machineFileFacade } from "../../facades/machine-file-facade";
import { contentDispositionAttachment } from "../../http/file-download";
import {
  busyErrorResponse,
  conditionalResponse,
  etagMatches,
  toFileError,
  withOpId,
  writeErrorResponse,
  writeOptionsFrom,
} from "../../http/file-route-helpers";
import { parseUploadRequest } from "../../http/file-upload-request";
import type { ReadMode } from "../../services/file-types";
import { computeListFingerprint, computeReadFingerprint, computeTreeFingerprint } from "../../services/workspace-fs";
import type { WebMachineRouteDependencies } from "../dependencies";

export { contentDispositionAttachment } from "../../http/file-download";

/**
 * `/web/environments/:id/fs/*` — workspace 文件系统控制台 API。
 *
 * 改为工厂：守卫必须与宿主的认证解析是同一份实例（Elysia 的 `macro` / `state` 是实例作用域的，父实例无法
 * 向已构造的子实例回填），因此由宿主注入 `authGuardPlugin`。
 */
export function createWebFsRoutes(deps: WebMachineRouteDependencies) {
  const app = new Elysia({ name: "web-fs", prefix: "/environments" }).use(deps.authGuardPlugin).model({
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

  // GET /:id/fs/tree — 递归扫描 workspace 树（黑名单过滤）
  app.get(
    "/:id/fs/tree",
    async ({ store, params, headers, set, error }) => {
      const authCtx = store.authContext!;
      try {
        const fs = await machineFileFacade.open(authCtx, params.id);
        const result = await fs.tree();
        const etag = computeTreeFingerprint(result.paths, result.mtimes, result.sizes);
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
      // query path 缺失或为空串时默认工作区根（与历史行为一致；空串对列目录无意义）
      const rawPath = (query as Record<string, string | undefined>)?.path;
      const queryPath = rawPath === undefined || rawPath === "" ? "." : rawPath;
      try {
        const fs = await machineFileFacade.open(authCtx, params.id);
        const entries = await fs.list(queryPath);
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
        const fs = await machineFileFacade.open(authCtx, params.id);
        const includeVersion = queryRecord?.includeVersion;
        if (includeVersion !== undefined && includeVersion !== "true" && includeVersion !== "false")
          return error(400, { error: { type: "validation_error", message: "includeVersion must be boolean" } });
        // 刷新地址会跨标签页复用；显式刷新和不可靠快照均不能用旧正文响应 304。
        const forceRefresh = preview && queryRecord?.retry !== undefined;
        const result = await fs.read(rawFilePath, mode, {
          includeVersion: includeVersion === "true",
          includeMtime: !forceRefresh,
        });
        let etag: string | undefined;
        if (!forceRefresh) {
          if (result.version) etag = `"${result.version}"`;
          else if (result.mtimeMs !== undefined && Number.isFinite(result.mtimeMs) && result.mtimeMs > 0)
            etag = computeReadFingerprint(result.size, result.mtimeMs);
        }
        if (etag) set.headers.ETag = etag;
        set.headers["Cache-Control"] = etag ? "no-cache" : "no-store";
        if (etag && etagMatches(headers["if-none-match"], etag)) {
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
              ...(result.version ? { version: result.version } : {}),
            },
          };
        }
        // 二进制流响应（preview 或下载，含 §7.8 auto 回退 binary）：一律显式标记
        // X-File-Type: binary——消费者据此区分「JSON 文本响应」与「二进制流响应」；
        // preview 流与 auto 回退流无法经此头区分（区分回退来源需机器端错误码，二期）
        if (result.version) set.headers["X-File-Version"] = result.version;
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
      const options = writeOptionsFrom(headers as Record<string, string | undefined>);
      const opId = options?.opId;
      // biome-ignore lint/suspicious/noExplicitAny: Elysia splat param not typed
      let rawDirPath = ((params as any)["*"] as string) || "";
      try {
        rawDirPath = decodeURIComponent(rawDirPath);
      } catch {
        /* 已解码 */
      }

      try {
        const { inputs, overwrite } = await parseUploadRequest(request);
        const fs = await machineFileFacade.open(authCtx, params.id);
        const result = await fs.upload(rawDirPath, inputs, { ...options, overwrite });
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
      const options = writeOptionsFrom(headers as Record<string, string | undefined>);
      const opId = options?.opId;
      // biome-ignore lint/suspicious/noExplicitAny: Elysia splat param not typed
      let rawFilePath = (params as any)["*"] as string;
      try {
        rawFilePath = decodeURIComponent(rawFilePath);
      } catch {
        /* 已解码 */
      }

      const b = body as { content?: string; createOnly?: boolean; expectedVersion?: string };
      if (typeof b.content !== "string")
        return error(400, withOpId({ error: { type: "validation_error", message: "content field required" } }, opId));

      if (b.content.length > 100 * 1024 * 1024)
        return error(
          413,
          withOpId({ error: { type: "validation_error", message: "Content exceeds 100MB limit" } }, opId),
        );

      try {
        const fs = await machineFileFacade.open(authCtx, params.id);
        const result = await fs.write(rawFilePath, b.content, {
          ...options,
          createOnly: b.createOnly,
          expectedVersion: b.expectedVersion,
        });
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
        description: "将文本内容写入 workspace 文件；createOnly 为 true 时仅原子创建，同名返回 409。",
      },
    },
  );

  // DELETE /:id/fs/* — 删除文件
  app.delete(
    "/:id/fs/*",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + 错误分支组合下类型推断不稳定
    async ({ store, params, headers, error }: any) => {
      const authCtx = store.authContext!;
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
        const fs = await machineFileFacade.open(authCtx, params.id);
        await fs.delete(rawFilePath, options);
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
      const options = writeOptionsFrom(headers as Record<string, string | undefined>);
      const opId = options?.opId;
      const { path } = body as { path: string };
      try {
        const fs = await machineFileFacade.open(authCtx, params.id);
        await fs.mkdir(path, options);
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
      const options = writeOptionsFrom(headers as Record<string, string | undefined>);
      const opId = options?.opId;
      const { oldPath, newPath } = body as { oldPath: string; newPath: string };
      try {
        const fs = await machineFileFacade.open(authCtx, params.id);
        await fs.rename(oldPath, newPath, options);
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
      // opId/ifMatch 对整批生效：单条 If-Match 不匹配的路径进 failed 列表（尽量删除
      // + 分别报告契约），op_id 在整批成功/错误响应中回显（§7.2 幂等重试标识）
      const options = writeOptionsFrom(headers as Record<string, string | undefined>);
      const opId = options?.opId;
      const { paths } = body as { paths: string[] };
      const deleted: string[] = [];
      const failed: Array<{ path: string; error: string }> = [];

      // 逐条执行并收集失败：批量删除的契约是"尽量删除 + 分别报告"，单条失败不中断整批。
      // 门面已把每条的诊断写入服务端日志，此处只透传面向用户的 message。
      try {
        for (const p of paths) {
          try {
            // 逐条开面：授权粒度与迁移前一致（环境归属校验原本在每次操作内执行），因此环境不可见时
            // 仍按批量契约落到 failed 列表，而不是把响应形状变成请求级错误。
            const fs = await machineFileFacade.open(authCtx, params.id);
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
      const path = (query as Record<string, string | undefined>)?.path;
      if (!path) return error(400, { error: { type: "validation_error", message: "path query parameter required" } });

      try {
        const fs = await machineFileFacade.open(authCtx, params.id);
        const stream = await fs.downloadZip(path);
        const dirName = path.split("/").filter(Boolean).pop() || "download";
        set.headers["Content-Type"] = "application/zip";
        set.headers["Content-Disposition"] = contentDispositionAttachment(`${dirName}.zip`);
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

  return app;
}
