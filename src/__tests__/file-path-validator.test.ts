import { describe, expect, test } from "bun:test";
import { assertSafePath, hasPathControlCharacter, normalizeUploadRelativePath } from "../services/file-path-validator";

describe("assertSafePath 基础安全校验（D5）", () => {
  test("绝对路径被拒绝（400 validation_error）", () => {
    // 绝对路径可逃逸环境目录，主服务必须在发送 file_op / 落盘前拒绝
    expect(() => assertSafePath("/etc/passwd")).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });

  test("`..` 段被拒绝（含 user/ 前缀混入的逃逸）", () => {
    // `..` 段可越出环境作用域，无论是否带 user/ 前缀都必须拒绝
    expect(() => assertSafePath("a/../b")).toThrowError(expect.objectContaining({ statusCode: 400 }));
    expect(() => assertSafePath("user/../../etc/passwd")).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });

  test("NUL 与控制字符被拒绝", () => {
    // NUL/控制字符不可见且可注入伪装，浏览器不会产生合法文件名
    expect(() => assertSafePath("a\u0000b")).toThrowError(expect.objectContaining({ statusCode: 400 }));
    expect(() => assertSafePath("a\u001fb")).toThrowError();
    expect(() => assertSafePath("a\u007fb")).toThrowError();
    expect(() => assertSafePath("a\u009fb")).toThrowError();
  });

  test("空路径放行（trim 后为空）", () => {
    // 空路径由调用方决定语义（如 tree 根目录），校验层不拦截
    expect(() => assertSafePath("")).not.toThrow();
    expect(() => assertSafePath("   ")).not.toThrow();
  });

  test("workspace 根内相对路径全部放行（不再强制 user/ 前缀）", () => {
    // F1 删除全局作用域强制：docs/、user/、根级文件均合法，越界防护由真实路径
    // 检查（realpath）承担，词法校验仅保留绝对路径 / `..` / 控制字符拦截
    expect(() => assertSafePath("docs/a.txt")).not.toThrow();
    expect(() => assertSafePath("user/a.txt")).not.toThrow();
    expect(() => assertSafePath("root-level.txt")).not.toThrow();
  });
});

describe("normalizeUploadRelativePath（D16 逃逸修复）", () => {
  test("undefined → 空串（调用方回退 file.name）", () => {
    // 未提供 relativePath 时返回空串而非 null，语义是"未提供"而非"非法"
    expect(normalizeUploadRelativePath(undefined)).toBe("");
  });

  test("非字符串 → null（整批拒绝）", () => {
    // 类型非法视为非法输入，调用方必须整批拒绝避免部分落盘
    expect(normalizeUploadRelativePath(123)).toBeNull();
    expect(normalizeUploadRelativePath(null)).toBeNull();
  });

  test("绝对路径 / `..` 段 / 控制字符 → null", () => {
    // 逃逸路径（D16）与注入字符全部拒绝，不得进入 join 落盘
    expect(normalizeUploadRelativePath("/etc/passwd")).toBeNull();
    expect(normalizeUploadRelativePath("../../evil.txt")).toBeNull();
    expect(normalizeUploadRelativePath("a\\..\\b.txt")).toBeNull();
    expect(normalizeUploadRelativePath("a\u0000b.txt")).toBeNull();
  });

  test('"." → null（文件 relativePath 为目录本身触发 EISDIR）', () => {
    // upload 的 relativePath/file.name 为 "." 时等价于目录本身，落盘触发 EISDIR
    // 并被 503 兜底误映射；F1 起显式拒绝（"." 作为目录 dir 参数仍合法，不受影响）
    expect(normalizeUploadRelativePath(".")).toBeNull();
  });

  test("合法相对路径 trim 后返回，反斜杠视为分隔符", () => {
    // 正/反斜杠均视为分隔符（防御 Windows 客户端路径），trim 前后等价
    expect(normalizeUploadRelativePath("  nested/b.txt ")).toBe("nested/b.txt");
    expect(normalizeUploadRelativePath("nested\\b.txt")).toBe("nested\\b.txt");
  });

  test("空字符串 → 空串（回退 file.name）", () => {
    // 空串与未提供同语义：回退 file.name
    expect(normalizeUploadRelativePath("")).toBe("");
  });
});

describe("hasPathControlCharacter 纯函数", () => {
  test("控制字符检测覆盖 C0/DEL/C1 区间，普通字符不误报", () => {
    // 码点遍历实现：C0（0x00–0x1F）、DEL（0x7F）、C1（0x80–0x9F）
    expect(hasPathControlCharacter("a\u0000b")).toBe(true);
    expect(hasPathControlCharacter("a\u001fb")).toBe(true);
    expect(hasPathControlCharacter("a\u007fb")).toBe(true);
    expect(hasPathControlCharacter("a\u009fb")).toBe(true);
    expect(hasPathControlCharacter("normal/file.txt")).toBe(false);
    expect(hasPathControlCharacter("中文文件.txt")).toBe(false);
  });
});
