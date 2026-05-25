import { join } from "node:path";

/**
 * 根据 organizationId + userId 计算用户隔离的 workspace 路径。
 *
 * 路径公式: {WORKSPACE_ROOT ?? cwd/workspaces}/{organizationId}/{userId}
 */
export function resolveWorkspacePath(organizationId: string, userId: string): string {
  const root = process.env.WORKSPACE_ROOT ?? join(process.cwd(), "workspaces");
  return join(root, organizationId, userId);
}
