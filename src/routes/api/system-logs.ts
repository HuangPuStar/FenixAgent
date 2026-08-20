import { error as logError } from "@fenix/logger";
import Elysia from "elysia";
import { systemApiAuthPlugin } from "../../plugins/system-api-auth";
import { ApiSystemErrorResponseSchema } from "../../schemas/api-system.schema";
import {
  SystemLogDownloadQuerySchema,
  SystemLogFilesResponseSchema,
  SystemLogSearchQuerySchema,
  SystemLogSearchResponseSchema,
} from "../../schemas/api-system-logs.schema";
import {
  InvalidLogFileError,
  LogFileNotFoundError,
  LogFileTooLargeError,
  type SystemLogService,
  systemLogService,
} from "../../services/system-log-service";

let service: SystemLogService = systemLogService;

/** 仅供路由测试替换日志数据源；传 null 恢复默认服务。 */
export function setSystemLogServiceForTests(override: SystemLogService | null): void {
  service = override ?? systemLogService;
}

const app = new Elysia({ name: "api-system-logs", prefix: "/api/system/logs" }).use(systemApiAuthPlugin);

app.get(
  "/",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在二进制错误分支与 JSON 成功响应混用时无法稳定推断 handler 返回类型
  async ({ error }: any) => {
    try {
      return { success: true as const, data: { files: await service.listFiles() } };
    } catch (err) {
      logError("[System-Logs] list failed", err);
      return error(500, { error: { code: "INTERNAL_ERROR", message: "Log files could not be listed" } });
    }
  },
  {
    systemApiKeyAuth: true,
    response: {
      200: SystemLogFilesResponseSchema,
      401: ApiSystemErrorResponseSchema,
      500: ApiSystemErrorResponseSchema,
    },
    detail: { tags: ["System Logs"], summary: "列出系统日志文件", description: "列出 logs 根目录直属的 .log 文件。" },
  },
);

app.get(
  "/search",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在二进制错误分支与 JSON 成功响应混用时无法稳定推断 handler 返回类型
  async ({ query, error }: any) => {
    try {
      const result = await service.searchFile({
        fileName: query.file,
        query: query.q,
        errorOnly: query.errorOnly,
        limit: query.limit,
      });
      return { success: true as const, data: result };
    } catch (err) {
      if (err instanceof InvalidLogFileError) {
        return error(400, { error: { code: "VALIDATION_ERROR", message: "Invalid log file" } });
      }
      if (err instanceof LogFileNotFoundError) {
        return error(404, { error: { code: "NOT_FOUND", message: "Log file not found" } });
      }
      if (err instanceof LogFileTooLargeError) {
        return error(413, { error: { code: "FILE_TOO_LARGE", message: "Log file is too large to search" } });
      }
      logError("[System-Logs] search failed", err);
      return error(500, { error: { code: "INTERNAL_ERROR", message: "Log file could not be searched" } });
    }
  },
  {
    systemApiKeyAuth: true,
    query: SystemLogSearchQuerySchema,
    response: {
      200: SystemLogSearchResponseSchema,
      400: ApiSystemErrorResponseSchema,
      401: ApiSystemErrorResponseSchema,
      404: ApiSystemErrorResponseSchema,
      413: ApiSystemErrorResponseSchema,
      500: ApiSystemErrorResponseSchema,
    },
    detail: {
      tags: ["System Logs"],
      summary: "搜索系统日志内容",
      description: "在指定 .log 文件内按关键字和 error 条件过滤，最多返回最近 1000 条匹配行。",
    },
  },
);

app.get(
  "/download",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在二进制错误分支与 JSON 成功响应混用时无法稳定推断 handler 返回类型
  async ({ query, error }: any) => {
    try {
      const resolved = await service.resolveDownload(query.file);
      return new Response(Bun.file(resolved.path).stream(), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": String(resolved.file.size),
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(resolved.file.name)}`,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (err) {
      if (err instanceof InvalidLogFileError) {
        return error(400, { error: { code: "VALIDATION_ERROR", message: "Invalid log file" } });
      }
      if (err instanceof LogFileNotFoundError) {
        return error(404, { error: { code: "NOT_FOUND", message: "Log file not found" } });
      }
      logError("[System-Logs] download failed", err);
      return error(500, { error: { code: "INTERNAL_ERROR", message: "Log file could not be downloaded" } });
    }
  },
  {
    systemApiKeyAuth: true,
    query: SystemLogDownloadQuerySchema,
    detail: {
      tags: ["System Logs"],
      summary: "下载系统日志文件",
      description: "以附件形式流式下载 logs 根目录直属的指定 .log 文件。",
    },
  },
);

export default app;
