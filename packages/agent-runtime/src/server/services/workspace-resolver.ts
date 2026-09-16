import { join } from "node:path";

/**
 * 根据 organizationId + userId + environmentId 计算隔离的 workspace 路径。
 *
 * 路径公式: {WORKSPACE_ROOT ?? cwd/workspaces}/{organizationId}/{userId}/{environmentId}
 */
export function resolveWorkspacePath(organizationId: string, userId: string, environmentId: string): string {
  const root = process.env.WORKSPACE_ROOT ?? join(process.cwd(), "workspaces");
  return join(root, organizationId, userId, environmentId);
}
