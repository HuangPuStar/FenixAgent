import { describe, expect, test } from "bun:test";
import {
  assertSafePath,
  ENV_SCOPE_PREFIX,
  hasPathControlCharacter,
  isPathInScope,
  normalizeUploadRelativePath,
} from "../services/file-path-validator";

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
});

describe("assertSafePath 作用域检查（相对路径须落在环境作用域前缀）", () => {
  test("不提供 scope 时不做作用域检查（基础校验兼容模式）", () => {
    // scope 可选：upload 的 relativePath 相对 dir 解析，作用域由 dir 控制
    expect(() => assertSafePath("docs/a.txt")).not.toThrow();
  });

  test("提供 scope 时，不在 user/ 作用域的相对路径被拒绝", () => {
    // 远程环境路径必须落在环境作用域前缀内（§7.7 与本地约束同构）
    expect(() => assertSafePath("docs/a.txt", ENV_SCOPE_PREFIX)).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(() => assertSafePath(".", ENV_SCOPE_PREFIX)).toThrowError();
    expect(() => assertSafePath("usera.txt", ENV_SCOPE_PREFIX)).toThrowError();
  });

  test("user/ 前缀与 user 本身通过作用域检查", () => {
    // 前端路径全部带 user/ 前缀（FilePickerDialog 固定在 user/ 作用域）
    expect(() => assertSafePath("user", ENV_SCOPE_PREFIX)).not.toThrow();
    expect(() => assertSafePath("user/a.txt", ENV_SCOPE_PREFIX)).not.toThrow();
    expect(() => assertSafePath("user/nested/deep.txt", ENV_SCOPE_PREFIX)).not.toThrow();
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

describe("hasPathControlCharacter / isPathInScope 纯函数", () => {
  test("控制字符检测覆盖 C0/DEL/C1 区间，普通字符不误报", () => {
    // 码点遍历实现：C0（0x00–0x1F）、DEL（0x7F）、C1（0x80–0x9F）
    expect(hasPathControlCharacter("a\u0000b")).toBe(true);
    expect(hasPathControlCharacter("a\u001fb")).toBe(true);
    expect(hasPathControlCharacter("a\u007fb")).toBe(true);
    expect(hasPathControlCharacter("a\u009fb")).toBe(true);
    expect(hasPathControlCharacter("normal/file.txt")).toBe(false);
    expect(hasPathControlCharacter("中文文件.txt")).toBe(false);
  });

  test("isPathInScope：等于 scope 或以 scope/ 开头才通过", () => {
    // 边界：user、user/ 开头通过；userx、空串不通过
    expect(isPathInScope("user", "user")).toBe(true);
    expect(isPathInScope("user/a", "user")).toBe(true);
    expect(isPathInScope("usera", "user")).toBe(false);
    expect(isPathInScope("", "user")).toBe(false);
    expect(isPathInScope("a/user", "user")).toBe(false);
  });
});
