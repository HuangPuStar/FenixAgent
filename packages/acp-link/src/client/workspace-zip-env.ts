/**
 * 工作区目录归档（file_op `zip`）子进程的环境白名单。
 *
 * 这条命令与 Agent 进程白名单（`../spawn-env.ts`）**语义不同，不复用**：归档是无人值守的一次性动作，
 * 输入是服务端请求里的工作区路径，只需要「命令能不能找到」与「时间戳按哪个时区写」，不需要 Agent CLI
 * 依赖的 `USER` / `SHELL` / `TERM` / `HOME` 等交互变量。少一个键就少一条可被请求驱动的读取路径。
 *
 * 直接继承 `process.env` 的问题有两层：
 * - acp-link 进程环境里带着 Agent 引擎配置（`ANTHROPIC_MODEL`、`CLAUDE_CODE_CLI_PATH`、`ACP_ENGINE_TYPE`）
 *   与用户级变量（`HOME`、`USER`），子进程没有任何理由读到它们；
 * - zip 会把宿主变量当**命令行选项**读：`man zip` 的 ENVIRONMENT 列出的 `ZIPOPT`（内容插入到 zip 命令
 *   之后）与 `ZIP`，等于让宿主任意改写这条命令的参数（ce-ee-engineering-standards §5.4）。
 *
 * 逐键理由：
 * - `PATH`：`/bin/sh` 用绝对路径，但脚本体里的 `zip` / `find` / `grep` 都按名字调用；缺了 PATH 时脚本
 *   会在 `find`/`grep` 的查找阶段失败并落入 `exit 73`（"ZIP target resolves outside workspace"），
 *   把环境问题伪装成路径安全问题。
 * - `TZ`：zip 用 `localtime()` 把文件 mtime 写进归档的 DOS 时间戳字段；缺省会退回系统默认时区，让同一
 *   目录在不同机器上打包出时间不同的归档。
 *
 * 不复用 `@fenix/platform-sdk` 的 `pickProcessEnv`：acp-link 是随 Agent 机器分发的客户端包，依赖里
 * 没有平台 SDK（也不应有——那份原语的服务端装配语义与本进程无关），因此这里保留一份自足的过滤器；
 * 两侧的键集本就不同，不构成需要抽象的重复。
 */

/** 允许继承给工作区归档子进程的宿主变量。 */
export const WORKSPACE_ZIP_ENV_KEYS: readonly string[] = ["PATH", "TZ"];

const WORKSPACE_ZIP_ENV_KEY_SET: ReadonlySet<string> = new Set(WORKSPACE_ZIP_ENV_KEYS);

/**
 * 按白名单构造归档子进程环境：白名单外的宿主变量（含 `ZIPOPT` 与引擎配置）一律不出现。
 *
 * @param base 打底来源，仅测试用于注入；生产固定为 `process.env`。
 */
export function buildWorkspaceZipEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (WORKSPACE_ZIP_ENV_KEY_SET.has(key)) inherited[key] = value;
  }
  return inherited;
}
