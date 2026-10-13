// web/pages/agent-panel/pages/knowledge-reparse-error.ts
// 重新解析失败的「稳定错误码 → 可操作文案」映射，未识别的失败回显服务端 message；纯函数、零 React。
//
// 从 `AgentKnowledgeBasesPage.tsx` 拆出（§4.7）：它是资源域重解析流程上一次性的（err → 文案）判定，
// 与页面的取数、渲染都无关，单独成档后调用方只剩一行 `toast.error(getReparseErrorMessage(err, t))`。

import { ApiError } from "@fenix/web-runtime/api/request";

/**
 * 重新解析失败的提示文案：先按**稳定错误码**取「用户下一步动作不同」的可操作文案，其余失败回显服务端 message。
 *
 * 五个稳定码各有明确下一步，译文比原文更有用：不存在要刷新列表、未同步要等同步、远端拒绝与网络异常要重试、
 * 无权限要找管理员。**未识别的码不套通用文案**（`SERVER_ERROR` / `VALIDATION_ERROR` / `UNKNOWN` 与后续新增
 * 的业务码）：一句「重新解析失败」既无法定位也没有下一步，此时上屏 `err.message`，字典文案只在无 message 时兜底。
 */
export function getReparseErrorMessage(err: unknown, t: (key: string) => string): string {
  const code = err instanceof ApiError ? err.code : null;
  switch (code) {
    case "NOT_FOUND":
      return t("reparse.failedNotFound");
    case "NOT_SYNCED":
      return t("reparse.failedNotSynced");
    case "REPARSE_FAILED":
      return t("reparse.failedRemote");
    case "NETWORK_ERROR":
      return t("reparse.failedNetwork");
    case "UNAUTHORIZED":
      return t("reparse.failedUnauthorized");
    default:
      return err instanceof Error && err.message ? err.message : t("reparse.failed");
  }
}
