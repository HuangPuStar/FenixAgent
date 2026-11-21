import { expect, test } from "bun:test";
import { EDITING_DEFAULTS, EditingError } from "../../contracts";

// 编辑错误与容量规则由独立包提供，调用方无需依赖 Machine 实现。
test("exposes bounded defaults and typed editing errors", () => {
  expect(EDITING_DEFAULTS.textMaxBytes).toBe(2 * 1024 * 1024);
  expect(EDITING_DEFAULTS.maxBuffers).toBe(50);
  expect(EDITING_DEFAULTS.maxBufferBytes).toBe(32 * 1024 * 1024);
  const error = new EditingError("conflict", "changed");
  expect(error.code).toBe("conflict");
  expect(error.message).toBe("changed");
});
