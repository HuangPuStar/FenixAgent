/**
 * MCP 本地服务器「可执行文件探测」子进程（`which`）的环境白名单。
 *
 * 探测命令由**管理端提交的 MCP 配置**驱动（`Bun.spawn(["which", cmd])`），因此这个子进程不能拿到宿主
 * 环境：它既不需要宿主密钥（`DATABASE_URL`、`RCS_*`、`LANGFUSE_*`），也不需要 `HOME` 之类的用户级信息
 * （ce-ee-engineering-standards §5.4：子进程只获得按用途显式构造的白名单）。
 *
 * 逐键理由（只有一个键）：
 * - `PATH`：`which` 的**全部价值**就是按 PATH 搜索可执行文件。缺了它，即使 Bun 仍能按自己的查找规则
 *   拉起 `which` 本体，`which` 自身也会因为读不到 PATH 而一律返回「未找到」（实测 `env: {}` 下
 *   `which sh` 退出码 1、有 PATH 时退出码 0）——配置探测会整体退化成假阴性，比缺功能更难排查。
 *
 * 刻意不放行：`HOME`（`which` 不读用户配置）、`ZIPOPT` 一类会被外部工具当选项的宿主变量，以及任何宿主密钥。
 *
 * 取值经 `@fenix/platform-sdk` 的 `pickProcessEnv`：本包生产代码不直读宿主进程环境（§1.5 的包边界
 * 静态条件零例外），键集这一层领域知识留在本模块。
 */

import { pickProcessEnv } from "@fenix/platform-sdk";

/** 允许继承给可执行文件探测子进程的宿主变量。 */
export const COMMAND_PROBE_ENV_KEYS: readonly string[] = ["PATH"];

/**
 * 按白名单构造探测子进程环境：白名单外的宿主变量一律不出现。
 *
 * `Bun.spawn` 的 `env` 选项是**替换**语义而不是合并：省略该选项才继承宿主进程环境，显式传入时子进程
 * 只看到传入的键（实测 `env: { ONLY_CHILD: "1" }` 下子进程环境只剩这一个键，`PATH` / `HOME` 均不在）。
 * 因此这里必须自带 `PATH`。
 *
 * @param base 打底来源，仅测试用于注入；省略时由平台原语现取宿主进程环境。
 */
export function buildCommandProbeEnv(base?: NodeJS.ProcessEnv): Record<string, string> {
  return pickProcessEnv(COMMAND_PROBE_ENV_KEYS, base);
}
