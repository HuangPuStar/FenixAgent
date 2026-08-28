/**
 * 编排域错误 → HTTP 响应的单一真相来源。
 *
 * 供 errorPlugin（全局错误处理）与 /api/instances（本地 mapApiError）复用，
 * 避免两处各自维护状态码 / message 映射导致漂移。
 *
 * 设计原因（A-P1.1 泄漏治理）：
 * - 编排域错误 message 可能携带 envId/machineId 等内部标识，例如
 *   agent-controller 抛出的 ConcurrencyExceededError 拼接 `Environment '${envId}' ...`
 *   （packages/orchestration/src/agent-controller/index.ts），原样返回会把内部
 *   资源标识泄漏给调用方，因此这里用通用模板替换；
 * - 模板与 packages/orchestration/src/errors.ts 各子类的默认 message 保持一致，
 *   因此默认抛出点（不传自定义 message）对调用方无感知差异，仅含 envId 等
 *   自定义 message 被替换；完整诊断由服务端日志保留。
 */

import type { OrchestrationError } from "@fenix/orchestration";

/** 编排域错误码 → HTTP 状态（未登记 code 保守落 500）。 */
export const ORCHESTRATION_STATUS_MAP: Record<string, number> = {
  ENVIRONMENT_NOT_FOUND: 404,
  CONCURRENCY_EXCEEDED: 409,
  LAUNCH_SPEC_BUILD_FAILED: 422,
  AGENT_NODE_UNAVAILABLE: 503,
  MACHINE_OFFLINE: 503,
};

/** 编排域错误码 → 对外通用 message 模板（见文件头注释的脱敏原因）。 */
export const ORCHESTRATION_MESSAGE_MAP: Record<string, string> = {
  ENVIRONMENT_NOT_FOUND: "Environment not found",
  CONCURRENCY_EXCEEDED: "Concurrency limit exceeded",
  LAUNCH_SPEC_BUILD_FAILED: "Failed to build launch spec",
  AGENT_NODE_UNAVAILABLE: "Agent node is unavailable",
  MACHINE_OFFLINE: "Target machine is offline",
};

/**
 * 编排域错误 → HTTP 状态 + 脱敏 message。
 * 未登记 code 保守落 500 + 通用文案，不暴露原始 message（新错误码漏登记时
 * 宁可泛化也不泄漏内部标识；错误类型仍由调用方透传的 code 字段保留）。
 */
export function mapOrchestrationErrorToHttp(error: OrchestrationError): { status: number; message: string } {
  return {
    status: ORCHESTRATION_STATUS_MAP[error.code] ?? 500,
    message: ORCHESTRATION_MESSAGE_MAP[error.code] ?? "Internal server error",
  };
}
