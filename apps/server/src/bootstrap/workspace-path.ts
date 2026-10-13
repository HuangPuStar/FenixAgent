import { join } from "node:path";

/**
 * Machine host port 的 workspace 路径解析：`{WORKSPACE_ROOT}/{organizationId}/{userId}/{environmentId}`。
 *
 * **为什么归宿主，而不是复用 `@fenix/agent-runtime` 的同名函数**（1.7 C1 拆分）：同一个部署值的两种取数
 * 语义。本函数代表「宿主持有的进程级根」，**每次调用直读 `process.env.WORKSPACE_ROOT`**；agent-runtime 的
 * `resolveWorkspacePath` 代表「包内请求路径」，读的是启动期注入的模块配置快照。生产下二者等价
 * （`WORKSPACE_ROOT` 启动后不再变），测试下不等价：`@fenix/platform-sdk/testing` 的 workspace 根锁
 * （`workspace-root-lock.ts`）按用例把根切到 `mkdtemp` 目录，只有直读 env 的实现跟得上，读快照会让锁
 * **静默失效**（同进程并发跑测试文件时，同一操作序列的写入与读取解析到不同的根）。
 *
 * Machine 侧的契约本来就定义在「进程级根」这一侧：它的消费方是 `workspace-fs` 的越权校验，每次都必须按
 * **当前**根判定，不能按启动期快照。宿主装配（`host-wiring.ts`）与宿主测试 preload（`test-utils/setup-mocks.ts`）
 * 共用本函数，测试与生产的根语义因此完全一致。
 *
 * 未设置 `WORKSPACE_ROOT` 时回退 `{cwd}/workspaces`——与宿主 `config.ts` 对空 env 的解析结果同形。这里
 * 刻意**不做 `resolve()`**：迁移前的实现同样不解析，保持逐字等价；测试的根锁传入的也都是绝对路径。
 */
export function resolveWorkspacePathFromEnv(organizationId: string, userId: string, environmentId: string): string {
  const root = process.env.WORKSPACE_ROOT ?? join(process.cwd(), "workspaces");
  return join(root, organizationId, userId, environmentId);
}
