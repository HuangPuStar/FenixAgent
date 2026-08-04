import { isCoreRuntimeError } from "@fenix/core";
import { OrchestrationError } from "@fenix/orchestration";
import Elysia, { ValidationError } from "elysia";
import { AppError } from "../errors";
import { mapOrchestrationErrorToHttp } from "../errors/orchestration-http";
import { logError } from "./logger";

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

    // 编排域错误：按稳定错误码映射 HTTP 状态（未映射的 code 保守落 500）。
    // message 必须脱敏 —— 编排域错误可能携带 envId/machineId（如 agent-controller
    // 的 ConcurrencyExceededError 拼接环境 ID），原样返回会泄漏内部资源标识；
    // 映射规则与 /api/instances 共用 src/errors/orchestration-http.ts 单一真相来源。
    if (error instanceof OrchestrationError) {
      const { status, message } = mapOrchestrationErrorToHttp(error);
      set.status = status;
      logError({ request, error, set });
      return { error: { type: error.code, message } };
    }

    // Core 运行时错误：NODE_OFFLINE 出现在 ensureNode 检查通过后、core launch 前断连的
    // 竞态窗口（毫秒级）。语义同为机器离线，映射 503 并统一错误码；原始 message 含
    // nodeId/machineId，必须脱敏（诊断信息由 logError 保留在服务端日志）。
    if (isCoreRuntimeError(error) && error.code === "NODE_OFFLINE") {
      set.status = 503;
      logError({ request, error, set });
      return { error: { type: "AGENT_NODE_UNAVAILABLE", message: "Agent node is offline" } };
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
    // 500 兜底 message 固定通用文案：未知错误可能携带 nodeId/machineId 等内部标识
    // （如 CoreRuntimeError "Core node is offline: ${nodeId}"），原样回传会泄漏；
    // 完整诊断由 logError 保留在服务端日志。Elysia 404 的 message 是固定
    // "NOT_FOUND" 文本（无内部信息），保留原样不影响脱敏。
    const message =
      type === "NOT_FOUND" ? (error instanceof Error ? error.message : String(error)) : "Internal server error";

    set.status = status;
    logError({ request, error, set });
    return { error: { type, message } };
  },
);
