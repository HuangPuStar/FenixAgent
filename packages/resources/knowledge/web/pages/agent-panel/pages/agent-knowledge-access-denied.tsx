/**
 * 知识库页面的「无权限」页级状态。
 *
 * 为什么单独成一个状态而不是复用目录面板的行内错误：401/403 下用户看不到任何知识库，
 * 页面上的创建 / 导入入口必然同样被拒。把无权限渲染成「带重试按钮的普通错误」会误导用户
 * 反复点击一个不会改变结果的请求，因此这里**只解释原因、不给重试入口**——真正的动作是
 * 重新登录或联系组织管理员。
 *
 * 判定按错误码而不是 HTTP 状态：`request()` 已把 401/403 归一为 `UNAUTHORIZED`
 * （`@fenix/web-runtime/api/request` 的 `statusToCode`），前端拿不到原始状态码，
 * 因此 401 与 403 在此共享同一个分支，口径与宿主其余页面一致。
 */

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { ApiError } from "@fenix/web-runtime/api/request";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

/** 列表请求失败是否属于「无权限」（401/403 的归一码）。 */
export function isKnowledgeAccessDenied(error: unknown): boolean {
  return readErrorCode(error) === "UNAUTHORIZED";
}

/**
 * 读取错误码。
 *
 * `unwrap` 抛出的 `ApiError` 与本模块 import 的是同一份模块实例，因此 `instanceof` 是主路径；
 * 结构判定是兜底：宿主若经别名重复打包 `@fenix/web-runtime`（同一模块两份实例），
 * `instanceof` 会失效，而按 `code` 字段判定仍认得无权限，避免把它错判成「可重试的普通错误」。
 */
function readErrorCode(error: unknown): string | null {
  if (error instanceof ApiError) return error.code;
  if (isErrorLike(error)) return typeof error.code === "string" ? error.code : null;
  return null;
}

/** 结构判定的类型守卫；`code` 刻意保持 unknown，取值前仍须做字符串收窄。 */
function isErrorLike(error: unknown): error is { code?: unknown } {
  return typeof error === "object" && error !== null && "code" in error;
}

/**
 * 无权限整页接管状态；`role="alert"` 让屏幕阅读器在进入页面时直接播报原因。
 *
 * 2026-09-22 前端去重：块本身改走库的 `EmptyState`（`tone="danger"`），
 * 配色（含 dark 变体）与图标尺寸交给组件；`flex-1` 撑满 AppPage 的剩余高度是页面级布局，仍由这里给。
 */
export function AgentKnowledgeAccessDenied() {
  const { t } = useTranslation(NS.KNOWLEDGE);
  return (
    <EmptyState
      tone="danger"
      role="alert"
      className="flex flex-1 flex-col items-center justify-center p-8"
      icon={<ShieldAlert />}
      title={t("accessDenied.title")}
      description={t("accessDenied.description")}
    />
  );
}
