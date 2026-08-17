// 文件路径前置校验（W6，P1-8：D5/D7 校验侧）
// 纯函数模块：拒绝绝对路径 / `..` 段 / NUL 与控制字符。本地与远程同构（§2.4 /
// §7.7）：远程路径在发送 file_op 前必须通过本校验；机器端仍承担最终隔离
// （主服务校验是防线而非依赖）。本模块只做字符串校验，不访问文件系统或 DB，
// 可直接单测。

import { isAbsolute } from "node:path";
import { ValidationError } from "../errors";

/** 路径是否含控制字符：C0（NUL–0x1F）、DEL（0x7F）与 C1（0x80–0x9F）。
 * 控制字符在文件系统中不可见且可被用于注入/伪装，浏览器不会产生合法文件名。
 * 用码点遍历而非正则字面量，规避 lint 的 noControlCharactersInRegex 规则。 */
export function hasPathControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
  }
  return false;
}

/** 统一前置校验（§2.4/§7.7）：拒绝绝对路径 / `..` 段 / NUL 与控制字符。
 * 空路径（trim 后）放行，语义由调用方决定（如 tree 根目录）。校验失败抛
 * 400 ValidationError（路由层映射 validation_error）。
 * 注：全局 user/ 作用域强制已删除（F1），workspace 根内全部路径均合法；
 * 越界防护由真实路径检查（realpath，workspace-fs）承担，词法检查仅作防御兜底。 */
export function assertSafePath(path: string): void {
  const trimmed = path.trim();
  if (!trimmed) return;
  if (isAbsolute(trimmed)) throw new ValidationError("路径不合法：不允许绝对路径");
  if (hasPathControlCharacter(trimmed)) throw new ValidationError("路径不合法：不允许控制字符");
  for (const segment of trimmed.split(/[\\/]+/)) {
    if (segment === "..") throw new ValidationError("路径不合法：不允许 `..` 段");
  }
}

/** 规范化并校验 upload 的 relativePath（D16 逃逸修复）：返回 null=非法（调用方必须
 * 整批拒绝）；""=未提供（回退 file.name）；正/反斜杠均视为分隔符，防御 Windows
 * 客户端路径。relativePath 相对 dir 解析，作用域由 dir 参数控制，此处不做作用域检查。
 * "." 同样视为非法（null）：作为文件 relativePath 时等价于目录本身，落盘触发 EISDIR，
 * 此前被 503 兜底误映射；"." 作为目录 dir 参数仍合法（映射 workspace 根，见
 * validateUploadInputs），两种语义互不影响。 */
export function normalizeUploadRelativePath(relPath: unknown): string | null {
  if (relPath === undefined) return "";
  if (typeof relPath !== "string") return null;
  const trimmed = relPath.trim();
  if (!trimmed) return "";
  if (trimmed === ".") return null;
  if (isAbsolute(trimmed)) return null;
  if (hasPathControlCharacter(trimmed)) return null;
  for (const segment of trimmed.split(/[\\/]+/)) {
    if (segment === "..") return null;
  }
  return trimmed;
}
