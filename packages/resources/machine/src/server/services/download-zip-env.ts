/**
 * `downloadZip` 本地后端打包子进程（`zip`）的环境白名单。
 *
 * 打包的输入是**用户工作区内容**：目录名、文件属性与压缩过程中的路径解析都由用户数据驱动；更直接的
 * 风险是 zip 会把宿主变量当**命令行选项**读——`man zip` 的 ENVIRONMENT 明确列出 `ZIPOPT`（内容会插入
 * 到 zip 命令之后）与 `ZIP`。直接继承 `process.env` 等于让宿主环境改写一条与路径校验、symlink 拒绝
 * 强相关的命令参数（ce-ee-engineering-standards §5.4：子进程只获得按用途显式构造的白名单）。
 *
 * 逐键理由：
 * - `PATH`：`spawn("zip")` 用相对命令名，缺失时命令查找阶段即失败（ENOENT），被上层映射成 503
 *   `file_service_unavailable`，打包功能整体不可用。
 * - `TZ`：zip 用 `localtime()` 把文件 mtime 写进归档的 DOS 时间戳字段（实测同一文件在 `TZ=UTC` 与
 *   `TZ=Asia/Shanghai` 下写入 04:00 与 12:00）。本仓部署镜像靠 `ENV TZ=Asia/Shanghai` 提供时区，
 *   漏掉会让用户下载到的 zip 时间整体偏移。
 *
 * 刻意不放行：`ZIPOPT` / `ZIP`（会被当选项）、`TMPDIR`（zip 的临时归档写在目标目录旁，不查临时目录）、
 * 以及 `DATABASE_URL`、`RCS_*`、`LANGFUSE_*` 等宿主密钥。
 *
 * 取值经 `@fenix/platform-sdk` 的 `pickProcessEnv`：本包生产代码不直读宿主进程环境（§1.5 的包边界
 * 静态条件零例外），键集这一层领域知识留在本模块。与 `@fenix/acp-link` 的客户端打包白名单分开维护：
 * 那份运行在 Agent 机器上，信任边界与本进程不同。
 */

import { pickProcessEnv } from "@fenix/platform-sdk";

/** 允许继承给 `zip` 打包子进程的宿主变量。 */
export const DOWNLOAD_ZIP_ENV_KEYS: readonly string[] = ["PATH", "TZ"];

/**
 * 按白名单构造 zip 子进程环境：白名单外的宿主变量（含密钥与 `ZIPOPT`）一律不出现。
 *
 * @param base 打底来源，仅测试用于注入；省略时由平台原语现取宿主进程环境。
 */
export function buildDownloadZipEnv(base?: NodeJS.ProcessEnv): Record<string, string> {
  return pickProcessEnv(DOWNLOAD_ZIP_ENV_KEYS, base);
}
