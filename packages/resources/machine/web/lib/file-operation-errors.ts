import { ApiError } from "@fenix/web-runtime/api/request";
import type { TFunction } from "i18next";
import type { MACHINE_NS } from "../i18n/namespace";

/** 冲突以稳定错误码映射本包文案，不将服务端内部路径或 syscall 展示给用户。 */
export function getFileOperationErrorMessage(error: unknown, t: TFunction<typeof MACHINE_NS>, fallback: string) {
  return error instanceof ApiError && error.code === "path_conflict" ? t("fileTree.pathConflict") : fallback;
}
