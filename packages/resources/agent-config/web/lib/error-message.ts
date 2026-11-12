import { ApiError } from "@fenix/web-runtime/api/request";
import type { TFunction } from "i18next";

/**
 * 取一句可上屏的服务端失败原因。
 *
 * `null` 表示取不到：抛出的是非 Error 值，或 message 为空——此时由调用方回落本包字典文案。
 */
export function errorMessage(error: unknown): string | null {
  return error instanceof Error && error.message ? error.message : null;
}

/** 进入失败提示：并发拒绝按稳定错误码解释，其他错误保留服务端原因。 */
export function agentEntryError(error: Error, t: TFunction<"agents">): { title: string; description?: string } {
  let reason: string | undefined;
  if (error instanceof ApiError) {
    switch (error.code) {
      case "AGENT_CONCURRENCY_LIMIT_REACHED":
        reason = t("platformInstanceLimitReached");
        break;
      case "USER_AGENT_CONCURRENCY_LIMIT_REACHED":
        reason = t("userInstanceLimitReached");
        break;
    }
  }
  return {
    title: t("enterFailed", { message: reason ?? error.message }),
    description: reason ? t("instanceLimitHelp") : undefined,
  };
}
