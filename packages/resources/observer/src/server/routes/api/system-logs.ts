import { error as logError } from "@fenix/logger";
import { ApiSystemErrorResponseSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import {
  SystemLogDownloadQuerySchema,
  SystemLogSearchQuerySchema,
  SystemLogSearchResponseSchema,
  SystemLogSourcesResponseSchema,
} from "../../schemas/api-system-logs.schema";
import {
  InvalidLogSourceError,
  LogSourceNotFoundError,
  LogSourceTooLargeError,
  type SystemLogService,
  systemLogService,
} from "../../services/system-log-service";
import type { SystemApiObserverRouteDependencies } from "../dependencies";

let service: SystemLogService = systemLogService;

/** 仅供路由测试替换日志数据源；传 null 恢复默认服务。 */
export function setSystemLogServiceForTests(override: SystemLogService | null): void {
  service = override ?? systemLogService;
}

/**
 * `/api/system/logs` 路由工厂（宿主注入系统 key 守卫，理由见 `../dependencies`）。
 *
 * 三个端点都只与**日志投影**打交道（§7「只读取经过权限过滤的日志投影，不得直接暴露底层日志文件」）：
 *   - `GET /` 列举服务端白名单化的日志源（`@fenix/logger` 的 `listLogSources`），响应里没有路径；
 *   - `GET /search` 按 `sourceId` 在投影后逐行检索；
 *   - `GET /download` 导出**同一投影**的 JSON Lines。
 * 客户端不传文件名或路径：`sourceId` 只能命中服务端枚举结果，因此 `/download` 也不提供「打包日志目录」
 * 或「按路径取文件」的能力。端点路径保持不变（对外协议的一部分），变的是输入与响应语义。
 *
 * 插件名与守卫名不同：Elysia 按 plugin `name` 去重，同名会让先构造的一方静默生效。
 */
export function createApiSystemLogsRoutes(deps: SystemApiObserverRouteDependencies) {
  const app = new Elysia({ name: "api-system-logs", prefix: "/api/system/logs" }).use(deps.systemApiGuardPlugin);

  app.get(
    "/",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在二进制错误分支与 JSON 成功响应混用时无法稳定推断 handler 返回类型
    async ({ error }: any) => {
      try {
        return { success: true as const, data: { sources: await service.listSources() } };
      } catch (err) {
        logError("[System-Logs] list failed", err);
        return error(500, { error: { code: "INTERNAL_ERROR", message: "Log sources could not be listed" } });
      }
    },
    {
      systemApiKeyAuth: true,
      response: {
        200: SystemLogSourcesResponseSchema,
        401: ApiSystemErrorResponseSchema,
        500: ApiSystemErrorResponseSchema,
      },
      detail: {
        tags: ["System Logs"],
        summary: "列出可检索的日志源",
        description: "列出本进程已知日志源（按天滚动的应用日志与 error 独立文件）的投影标识与体量。",
      },
    },
  );

  app.get(
    "/search",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在二进制错误分支与 JSON 成功响应混用时无法稳定推断 handler 返回类型
    async ({ query, error }: any) => {
      try {
        const result = await service.search({
          sourceId: query.sourceId,
          query: query.q,
          errorOnly: query.errorOnly,
          limit: query.limit,
        });
        return { success: true as const, data: result };
      } catch (err) {
        return mapLogSourceError(err, error, "search");
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
        summary: "检索系统日志投影",
        description: "在指定日志源内按关键字和 error 条件过滤投影后的日志行，最多返回最近 1000 条匹配行。",
      },
    },
  );

  app.get(
    "/download",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在二进制错误分支与 JSON 成功响应混用时无法稳定推断 handler 返回类型
    async ({ query, error }: any) => {
      try {
        const { source, body } = await service.openExport(query.sourceId);
        return new Response(body, {
          headers: {
            // 投影结果是 JSON Lines（每行一条已脱敏、已裁剪的记录），不是底层文件字节。
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${source.id}.projected.jsonl`)}`,
            "X-Content-Type-Options": "nosniff",
            // 日志可能含内部标识，禁止中间层与浏览器缓存这份导出。
            "Cache-Control": "no-store",
          },
        });
      } catch (err) {
        return mapLogSourceError(err, error, "download");
      }
    },
    {
      systemApiKeyAuth: true,
      query: SystemLogDownloadQuerySchema,
      detail: {
        tags: ["System Logs"],
        summary: "导出系统日志投影",
        description: "以 JSON Lines 附件形式导出指定日志源的投影结果；与检索共用同一脱敏与裁剪口径。",
      },
    },
  );

  return app;
}

/**
 * 日志源错误 → 协议状态码。
 *
 * 三档都**不回显输入**：400 只说「ID 形状非法」（客户端传了文件名或路径即命中此档），404 与 413 同样
 * 只说「找不到」与「太大」——把「你试的路径不存在」这类反馈交回去，等于用状态码做路径探测的信道。
 *
 * `respond` 的形状就是宿主守卫注入的 `error` 装饰器（`(code, body) => Response`）：这里显式写出签名，
 * 免得为了拿到它而把整个 handler 上下文标成 `any`。
 */
function mapLogSourceError(
  err: unknown,
  respond: (code: number, response: unknown) => Response,
  operation: "search" | "download",
): Response {
  if (err instanceof InvalidLogSourceError) {
    return respond(400, { error: { code: "VALIDATION_ERROR", message: "Invalid log source id" } });
  }
  if (err instanceof LogSourceNotFoundError) {
    return respond(404, { error: { code: "NOT_FOUND", message: "Log source not found" } });
  }
  if (err instanceof LogSourceTooLargeError) {
    return respond(413, { error: { code: "FILE_TOO_LARGE", message: "Log source is too large to read" } });
  }
  logError(`[System-Logs] ${operation} failed`, err);
  return respond(500, { error: { code: "INTERNAL_ERROR", message: "Log source could not be read" } });
}
