import { OrchestrationError } from "@fenix/orchestration";
import Elysia, { ValidationError } from "elysia";
import { AppError } from "../errors";
import { logError } from "./logger";

/**
 * 编排域错误码 → HTTP 状态映射。
 * OrchestrationError 不是 AppError，无 statusCode 字段，必须在此显式映射，
 * 否则编排域错误（环境不存在/并发超限/节点离线等）会全部落为 500。
 */
const ORCHESTRATION_STATUS_MAP: Record<string, number> = {
  ENVIRONMENT_NOT_FOUND: 404,
  CONCURRENCY_EXCEEDED: 409,
  LAUNCH_SPEC_BUILD_FAILED: 422,
  AGENT_NODE_UNAVAILABLE: 503,
  MACHINE_OFFLINE: 503,
};

// 必须显式 `{ as: "global" }`：Elysia 的 use() 只合并 plugin 中 scope 为
// global/scoped 的 hook，onError 默认 scope 是 local，缺省时本插件对主 app
// 路由完全不生效（所有自定义错误映射会静默落为 Elysia 默认 500 纯文本）。
//
// 错误日志（logError）合并在本插件内部而不是挂到主 app 的 onError：onError
// 链中第一个返回响应的 hook 会终止链，若 errorPlugin 返回映射响应而 logError
// 注册在其后，日志会永远不执行；注册在其前则读到的是未映射的默认状态。
// 因此这里先完成状态映射（set.status）再写日志，保证日志记录的是最终响应状态。
export const errorPlugin = new Elysia({ name: "error-handler" }).onError(
  { as: "global" },
  ({ error, set, code, request }) => {
    // 自定义错误类优先 — Service 层抛出的 AppError 子类
    if (error instanceof AppError) {
      set.status = error.statusCode;
      logError({ request, error, set });
      return { error: { type: error.code, message: error.message } };
    }

    // 编排域错误：按稳定错误码映射 HTTP 状态（未映射的 code 保守落 500）
    if (error instanceof OrchestrationError) {
      set.status = ORCHESTRATION_STATUS_MAP[error.code] ?? 500;
      logError({ request, error, set });
      return { error: { type: error.code, message: error.message } };
    }

    // Elysia schema 校验失败 — ValidationError.message 默认是 ZodError 完整序列化 JSON
    // （含 unionErrors 所有分支的 issues），原样返回会让前端控制台也被垃圾 JSON 刷屏。
    // 这里只回首个错误的 path + 摘要，详细诊断走 server logger。
    if (error instanceof ValidationError) {
      set.status = 400;
      const firstError = error.all[0];
      const path = firstError?.path ?? "";
      const summary = firstError?.summary ?? firstError?.message ?? "validation failed";
      logError({ request, error, set });
      return {
        error: {
          type: "VALIDATION_ERROR",
          message: path ? `${path}: ${summary}` : summary,
        },
      };
    }

    // DrizzleQueryError（PG 驱动包装错误）：非法 UUID 格式视为资源不存在。
    // 原位于 authGuardPlugin.onError（同因 local scope 从未生效），错误处理
    // 统一收敛到本插件后随迁，保证所有路由（含未挂 authGuard 的）行为一致。
    const pgMessage =
      error instanceof Error ? (error.cause as { message?: string } | undefined)?.message || error.message : "";
    if (pgMessage.includes("invalid input syntax for type uuid")) {
      set.status = 404;
      logError({ request, error, set });
      return { error: { type: "NOT_FOUND", message: "Resource not found" } };
    }

    const status = code === "NOT_FOUND" ? 404 : 500;
    const type = code === "NOT_FOUND" ? "NOT_FOUND" : "INTERNAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);

    set.status = status;
    logError({ request, error, set });
    return { error: { type, message } };
  },
);
