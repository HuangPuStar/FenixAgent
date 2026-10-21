import { createPublicError, type PublicErrorType, serializePublicErrorLog } from "../public-error";
import type { PublicError } from "../schema";

/** 运行时错误只暴露稳定分类和安全文案，并以同一 ID 写入安全诊断日志。 */
export function agentRuntimeError(
  type: PublicErrorType,
  stage: string,
  log: ((message: string) => void) | undefined,
): PublicError {
  const error = createPublicError(type);
  log?.(serializePublicErrorLog(error, stage));
  return error;
}

const MAX_UPSTREAM_ERROR_LOG_LENGTH = 1_000;

/**
 * 上游错误只进入服务端诊断日志：擦除常见凭证、URL 与本机绝对路径，折叠空白并限制长度。
 * 该文本不得进入 PublicError 或浏览器响应。
 */
export function sanitizeUpstreamErrorMessage(raw: unknown): string | undefined {
  if (typeof raw !== "string") return;
  const sanitized = raw
    .replace(/\b(?:https?|wss?):\/\/[^\s<>'"`]+/giu, "[REDACTED_URL]")
    .replace(
      /\b(?:bearer\s+)?[A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key)[A-Za-z0-9_-]*\s*[:=]\s*[^\s,;]+/giu,
      "[REDACTED_SECRET]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "[REDACTED_SECRET]")
    .replace(
      /(?:^|\s)(?:~\/|\/(?:Users|home|var|tmp|private|etc|opt|srv|workspace)\/)[^\s<>'"`]+/gu,
      (value) => `${value.startsWith(" ") ? " " : ""}[REDACTED_PATH]`,
    )
    .replace(/\s+/g, " ")
    .trim();
  if (!sanitized) return;
  return Array.from(sanitized).slice(0, MAX_UPSTREAM_ERROR_LOG_LENGTH).join("");
}

/** 只识别 Peri 当前稳定的 error.data.kind/status 白名单；message 和未知 data 不参与公开分类。 */
export function classifyPromptRejection(error: Record<string, unknown> | undefined): PublicErrorType {
  const data = error?.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return "AGENT_RUNTIME.PROMPT_REJECTED";
  }

  const failure = data as Record<string, unknown>;
  if (failure.kind === "internal") return "AGENT_RUNTIME.REQUEST_FAILED";
  if (failure.kind === "llm") return "AGENT_RUNTIME.LLM_API_ERROR";
  if (failure.kind !== "llm_http") return "AGENT_RUNTIME.PROMPT_REJECTED";

  const status = failure.status;
  if (status === 401 || status === 403) return "AGENT_RUNTIME.LLM_API_CONFIGURATION_ERROR";
  if (status === 429) return "AGENT_RUNTIME.LLM_API_RATE_LIMITED";
  return "AGENT_RUNTIME.LLM_API_ERROR";
}
