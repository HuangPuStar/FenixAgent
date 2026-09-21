/**
 * Agent 子进程环境白名单。
 *
 * 背景：宿主曾把整个 `process.env` 打底透传给第三方 Agent 进程，泄漏 `DATABASE_URL`、
 * `RCS_API_KEYS`、`RCS_SYSTEM_API_KEYS`、`LANGFUSE_SECRET_KEY` 等宿主密钥；`python-executor`
 * 的 `pip install` 会执行任意第三方包代码，等于「任意代码执行 + 密钥窃取」
 * （ce-ee-engineering-standards §10.6.3：子进程和 Provider 只获得白名单）。
 *
 * `launchSpec.env` 本身已经是白名单（组装器只放 `memory.env`、langfuse 三键与 `extraEnv`），
 * 因此这里只替换**打底**：从 `process.env` 换成白名单，合并方向仍为 `{ ...白名单, ...launchSpecEnv }`。
 */

/**
 * 允许继承给 Agent 子进程的宿主变量。逐键理由：
 * - `PATH`：spawn 相对命令名，且 Agent 内部要查找 git / rg 等子工具。
 * - `HOME` / `USER` / `LOGNAME`：Agent CLI 的全局配置、凭据缓存与用户级目录推导。
 * - `SHELL`：Agent 调用交互式 shell 工具时的默认 shell；`PWD`：部分 CLI 的逻辑工作目录初值。
 * - `TMPDIR` / `TMP` / `TEMP`：临时目录，缺失会退回 /tmp 或写入不可写路径。
 * - `TERM`：终端能力协商；`TZ` / `LANG`：时间戳与 locale 基线（与 `LC_` 前缀同源）。
 */
export const AGENT_PROCESS_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "TZ",
  "LANG",
];

/**
 * 允许按前缀继承的前缀，只放行 locale（`LC_*`）。
 *
 * `RCS_*` 与 `ANTHROPIC_*` 一律不做前缀放行：`RCS_*` 是宿主部署面（含 `RCS_API_KEYS`、
 * `RCS_SYSTEM_API_KEYS`、`RCS_SECRET_*`），模型 key / baseUrl / model 由 `launchSpec` 经
 * settings 文件显式下发、不依赖继承。按前缀放宽会让宿主密钥随下一次改名重新泄漏。
 */
export const AGENT_PROCESS_ENV_PREFIXES: readonly string[] = ["LC_"];

const AGENT_PROCESS_ENV_KEY_SET: ReadonlySet<string> = new Set(AGENT_PROCESS_ENV_KEYS);

/**
 * 按白名单构造 Agent 子进程环境，`launchSpecEnv` 覆盖同名继承值。
 *
 * @param launchSpecEnv 组装器产出的白名单（memory env + langfuse + extraEnv），同名优先。
 * @param base 打底来源，仅测试用于注入；生产固定为 `process.env`。
 */
export function buildAgentProcessEnv(
  launchSpecEnv?: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (AGENT_PROCESS_ENV_KEY_SET.has(key) || AGENT_PROCESS_ENV_PREFIXES.some((p) => key.startsWith(p))) {
      inherited[key] = value;
    }
  }
  return { ...inherited, ...launchSpecEnv };
}
