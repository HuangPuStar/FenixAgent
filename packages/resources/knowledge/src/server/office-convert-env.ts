/**
 * Office 文档转 PDF 的 LibreOffice 转换子进程环境白名单。
 *
 * 转换的输入是**用户上传**的文档：宏、外部引用与解析器缺陷都可能让转换进程执行非预期代码，
 * 因此它不能拿到宿主环境——直接继承 `process.env` 等于把 `DATABASE_URL`、`RCS_API_KEYS`、
 * `RCS_SECRET_*` 交给一个由不可信输入驱动的进程（ce-ee-engineering-standards §5.4：
 * 子进程只获得按模块显式构造的白名单）。
 *
 * 逐键理由：
 * - `PATH`：`execFile("libreoffice" | "soffice")` 走命令查找，未给绝对路径。
 * - `HOME`：LibreOffice 用户 profile（`$HOME/.config/libreoffice`）的落点，缺失时 headless
 *   转换通常因无法创建 profile 直接失败。
 * - `TMPDIR` / `LANG` / `TZ`（与 `LC_` 前缀同源）：转换中间文件的暂存位置与文档日期、
 *   locale 的解析基线——不传不会失败，但会让同一文档在不同宿主上解析出不同结果。
 *
 * 与 `@fenix/acp-link` 的 Agent 白名单分开维护：这里是无人值守的一次性转换，不需要 Agent CLI
 * 依赖的 `USER` / `SHELL` / `TERM` 等交互变量，也不接受调用方追加变量。
 */

/** 允许继承给转换子进程的宿主变量。 */
export const OFFICE_CONVERT_ENV_KEYS: readonly string[] = ["PATH", "HOME", "TMPDIR", "LANG", "TZ"];

/** 允许按前缀继承的前缀，只放行 locale（`LC_*`）。 */
export const OFFICE_CONVERT_ENV_PREFIXES: readonly string[] = ["LC_"];

const OFFICE_CONVERT_ENV_KEY_SET: ReadonlySet<string> = new Set(OFFICE_CONVERT_ENV_KEYS);

/**
 * 按白名单构造转换子进程环境：白名单外的宿主变量（含密钥类）一律不出现。
 *
 * @param base 打底来源，仅测试用于注入；生产固定为 `process.env`。
 */
export function buildOfficeConvertEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (OFFICE_CONVERT_ENV_KEY_SET.has(key) || OFFICE_CONVERT_ENV_PREFIXES.some((p) => key.startsWith(p))) {
      inherited[key] = value;
    }
  }
  return inherited;
}
