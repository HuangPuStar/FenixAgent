import type { AuthContext } from "./auth";
import { errorResponse } from "./auth";

/**
 * 校验当前认证上下文是否有权访问指定组织的资源。
 * 返回 undefined 表示通过，否则返回 403 Response。
 *
 * 用法：const denied = requireOrgScope(store.authContext, resourceOrgId);
 *       if (denied) return denied;
 */
export function requireOrgScope(
  authContext: AuthContext | null,
  resourceOrgId: string | null | undefined,
): Response | undefined {
  if (!authContext || !resourceOrgId) {
    return errorResponse(403, { error: { type: "forbidden", message: "Access denied" } });
  }
  if (authContext.organizationId !== resourceOrgId) {
    return errorResponse(403, {
      error: { type: "forbidden", message: "Resource does not belong to your organization" },
    });
  }
  return;
}
