/**
 * Workflow 节点子进程环境白名单。
 *
 * 节点代码由用户编写，且 python 节点的 `pip install` 会执行任意第三方包代码，因此**不能**继承
 * 宿主 `process.env`（否则泄漏 `DATABASE_URL`、`RCS_API_KEYS`、`LANGFUSE_SECRET_KEY` 等）
 * ——ce-ee-engineering-standards §10.6.3：子进程和 Provider 只获得白名单。
 *
 * 与 `packages/acp-link/src/spawn-env.ts` 的 Agent 白名单分开维护：节点是用户代码，不需要
 * Agent CLI 依赖的 `USER` / `LOGNAME` / `SHELL` / `TERM` 等交互变量，因此这里更短。
 * 部署方若需要给节点传变量，走节点 `env` / `secrets` 字段，不放宽本白名单。
 */

/** 允许继承给节点的宿主变量：命令查找、用户目录、临时目录与 locale/时区基线。 */
export const WORKFLOW_NODE_ENV_KEYS: readonly string[] = ["PATH", "HOME", "TMPDIR", "LANG", "TZ"];

/** 允许按前缀继承的前缀，只放行 locale（`LC_*`）。 */
export const WORKFLOW_NODE_ENV_PREFIXES: readonly string[] = ["LC_"];

const WORKFLOW_NODE_ENV_KEY_SET: ReadonlySet<string> = new Set(WORKFLOW_NODE_ENV_KEYS);

/**
 * 按白名单构造节点子进程环境，`nodeEnv`（节点 env / inputs / secrets 的合并结果）覆盖同名继承值。
 *
 * 值类型保留 `undefined` 以兼容既有调用点：`Bun.spawn` 选项与写入节点 `env` 的中间结构都用
 * `Record<string, string | undefined>`，收窄为 `string` 会破坏这些调用点的类型。
 */
export function buildWorkflowNodeEnv(
  nodeEnv?: Record<string, string | undefined>,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const inherited: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (WORKFLOW_NODE_ENV_KEY_SET.has(key) || WORKFLOW_NODE_ENV_PREFIXES.some((p) => key.startsWith(p))) {
      inherited[key] = value;
    }
  }
  return { ...inherited, ...nodeEnv };
}
