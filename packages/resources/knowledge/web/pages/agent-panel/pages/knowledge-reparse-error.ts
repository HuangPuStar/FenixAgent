// web/pages/agent-panel/pages/knowledge-reparse-error.ts
// 重新解析失败的「稳定错误码 → 字典键」映射（§9.3 的错误文案口径），纯函数、零 React。
//
// 从 `AgentKnowledgeBasesPage.tsx` 拆出（§4.7）：它是资源域重解析流程上一次性的（err → 文案）判定，
// 与页面的取数、渲染都无关，单独成档后调用方只剩一行 `toast.error(getReparseErrorMessage(err, t))`。

import { ApiError } from "@fenix/web-runtime/api/request";

/**
 * 重新解析失败的提示文案：按统一请求层归一后的**稳定错误码**取字典键（§9.3）。
 *
 * 为什么不能直接上屏 `err.message`：`unwrap()` 抛出的 `ApiError.message` 就是后端错误信封里的原文，
 * 重新解析接口的 `REPARSE_FAILED` 分支会把 RAGFlow 的异常文本透传进来
 * （`packages/resources/knowledge/src/server/routes/web/knowledge-bases.ts` 的 reparse 路由），
 * 404 分支的「资源不存在 / 知识库不存在」也只是服务端内部措辞。原始 message 与堆栈留给调用方的
 * `console.error`，界面只认码。
 *
 * 只映射「用户下一步动作不同」的五个码：不存在要刷新列表、未同步要等同步、远端拒绝与网络异常要重试、
 * 无权限要找管理员。其余（`SERVER_ERROR` / `VALIDATION_ERROR` / `UNKNOWN` 与后续新增的业务码）一律
 * 走通用文案 `reparse.failed`——不认识的失败不该被翻译成一句看似精确的承诺。
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
      return t("reparse.failed");
  }
}
