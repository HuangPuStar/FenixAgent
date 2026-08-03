import { OrchestrationError } from "@fenix/orchestration";
import Elysia, { ValidationError } from "elysia";
import { AppError } from "../errors";

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

export const errorPlugin = new Elysia({ name: "error-handler" }).onError(({ error, set, code, request }) => {
  // biome-ignore lint/suspicious/noExplicitAny: custom request property injected by logger derive hook
  const requestId = (request as any).__requestId as string | undefined;
  if (requestId) {
    set.headers["X-Request-Id"] = requestId;
  }

  // 自定义错误类优先 — Service 层抛出的 AppError 子类
  if (error instanceof AppError) {
    set.status = error.statusCode;
    return { error: { type: error.code, message: error.message } };
  }

  // 编排域错误：按稳定错误码映射 HTTP 状态（未映射的 code 保守落 500）
  if (error instanceof OrchestrationError) {
    set.status = ORCHESTRATION_STATUS_MAP[error.code] ?? 500;
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
    return {
      error: {
        type: "VALIDATION_ERROR",
        message: path ? `${path}: ${summary}` : summary,
      },
    };
  }

  const status = code === "NOT_FOUND" ? 404 : 500;
  const type = code === "NOT_FOUND" ? "NOT_FOUND" : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : String(error);

  set.status = status;
  return { error: { type, message } };
});
