// web/__tests__/file-tree-name-validation.test.ts
// 文件树重命名 / 移动的前置校验（浏览器侧与服务端文件系统契约对齐的那一层）。
//
// 为什么在这里补：`web/src/__tests__/file-tree-dialog.test.tsx` 的「覆盖下降说明」此前记着这三条纯函数
// 「仍只在宿主 `apps/web/src/shell/artifacts/FileTreeTab.tsx`，随 §1.6 迁移」，因为容器当时不在本包；
// 2026-09-24（台账 D2）容器迁入 `web/components/FileTreeTab.tsx` 后，欠账的覆盖随实现一起归位。
// 校验口径必须与后端一致：basename 按 UTF-8 **字节数**限 255（NAME_MAX），且不得含 `/`、NUL，不能是
// `.` / `..`；移动用完整路径，只挡空值与 NUL（workspace 越界与 symlink 由服务端统一校验）。

import { describe, expect, test } from "bun:test";

import { getFileTreeNameByteLength, isValidFileTreeBasename, isValidFileTreeMovePath } from "../components/FileTreeTab";

describe("getFileTreeNameByteLength", () => {
  // 字节数而非字符数是服务端 NAME_MAX 的契约：中文名 1 字符占 3 字节。
  test("按 UTF-8 字节计数（中文与 ASCII 口径不同）", () => {
    expect(getFileTreeNameByteLength("abc")).toBe(3);
    expect(getFileTreeNameByteLength("文件")).toBe(6);
  });

  // 先 trim 再校验的口径要在长度上也一致：调用方传的是未修剪的原串。
  test("空串为 0 字节", () => {
    expect(getFileTreeNameByteLength("")).toBe(0);
  });
});

describe("isValidFileTreeBasename", () => {
  // 常规文件名（含中文与空格）必须放行，否则重命名在主路径上先失败。
  test("普通文件名合法", () => {
    expect(isValidFileTreeBasename("foo.ts")).toBe(true);
    expect(isValidFileTreeBasename(" 新 文件.txt ")).toBe(true);
  });

  // 空值、路径分隔符、NUL 与相对目录记号都是服务端会拒绝的形态，这里必须同样拒绝。
  test("空值、斜杠、NUL、点目录记号都非法", () => {
    for (const value of ["", "   ", "a/b", "a\0b", ".", ".."]) {
      expect(isValidFileTreeBasename(value)).toBe(false);
    }
  });

  // 边界取 UTF-8 字节数：255 字节放行、256 字节拒绝（中文按 3 字节计算）。
  test("255 字节为上限，超出即非法", () => {
    expect(isValidFileTreeBasename("a".repeat(255))).toBe(true);
    expect(isValidFileTreeBasename("a".repeat(256))).toBe(false);
    expect(isValidFileTreeBasename("文".repeat(85))).toBe(true);
    expect(isValidFileTreeBasename("文".repeat(86))).toBe(false);
  });
});

describe("isValidFileTreeMovePath", () => {
  // 移动接受完整目标路径，因此 `a/b` 这类带分隔符的路径必须合法。
  test("带分隔符的完整路径合法", () => {
    expect(isValidFileTreeMovePath("docs/a.txt")).toBe(true);
  });

  // 只有空值与 NUL 被挡：越界与 symlink 逃逸由服务端校验，前端不重复实现。
  test("空值与 NUL 非法", () => {
    expect(isValidFileTreeMovePath("")).toBe(false);
    expect(isValidFileTreeMovePath("   ")).toBe(false);
    expect(isValidFileTreeMovePath("a\0b")).toBe(false);
  });
});
