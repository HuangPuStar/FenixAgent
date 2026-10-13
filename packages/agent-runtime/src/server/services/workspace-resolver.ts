import { join } from "node:path";
import { getAgentRuntimeConfig } from "../config";

/**
 * 根据 organizationId + userId + environmentId 计算隔离的 workspace 路径。
 *
 * 路径公式: {workspaceRoot}/{organizationId}/{userId}/{environmentId}
 *
 * 根取**本模块配置的 `workspaceRoot`**（宿主启动期解析好的绝对路径），不再直读 `process.env.WORKSPACE_ROOT`
 * ——1.7 C 块收口的「server 装配面内唯一真违规」。
 * 配置由宿主在装配期注入，因此本函数只能在请求、任务或启动逻辑中调用（与 `getAgentRuntimeConfig` 同一条
 * 时序约束）。
 *
 * **不要再把它绑给 Machine 的 host port**（1.7 C1 拆分的正是这一点）。机器侧需要的是「每次调用直读
 * `process.env.WORKSPACE_ROOT`」：`@fenix/platform-sdk/testing` 的 workspace 根锁
 * （`workspace-root-lock.ts`）按用例把根切到 `mkdtemp` 目录，而本函数读的是启动期快照——绑过去会让锁静默
 * 失效（同进程并发跑测试文件时，写入与读取解析到不同的根）。Machine host port 的实现归宿主
 * （`apps/server/src/bootstrap/workspace-path.ts`）。
 */
export function resolveWorkspacePath(organizationId: string, userId: string, environmentId: string): string {
  return join(getAgentRuntimeConfig().workspaceRoot, organizationId, userId, environmentId);
}
