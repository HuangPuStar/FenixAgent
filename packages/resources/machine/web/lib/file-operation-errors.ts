import { ApiError } from "@fenix/web-runtime/api/request";
import type { TFunction } from "i18next";
import type { MACHINE_NS } from "../i18n/namespace";

/**
 * 取一句可上屏的失败原因。
 *
 * 只有 `path_conflict` 换成本包稳定文案：该码的 message 会带上服务端内部路径与 syscall 措辞，
 * 且此时用户下一步动作固定是「改名重试」，不需要原文。其余错误一律回显服务端 message
 * （`unwrap` 抛出的 `ApiError.message` 即错误信封原文），让用户与测试都能定位后端故障；
 * 仅当 message 为空（服务端未给出可读描述，或抛出的是非 Error 值）时才退回 `fallback` 字典文案。
 */
export function getFileOperationErrorMessage(error: unknown, t: TFunction<typeof MACHINE_NS>, fallback: string) {
  if (error instanceof ApiError && error.code === "path_conflict") return t("fileTree.pathConflict");
  return error instanceof Error && error.message ? error.message : fallback;
}
