import { describe, expect, test } from "bun:test";
// 从 environment-core 直接导入，绕过 environment barrel re-export 的 preload mock
import { validateWorkspacePath } from "../services/environment-core";

// 路径校验函数测试
describe("validateWorkspacePath", () => {
  test("拒绝非绝对路径", () => {
    expect(validateWorkspacePath("relative/path")).toBe("workspace 路径必须是绝对路径");
  });

  test("拒绝根目录", () => {
    expect(validateWorkspacePath("/")).toContain("系统目录");
  });

  test("拒绝 /etc", () => {
    expect(validateWorkspacePath("/etc")).toContain("系统目录");
  });

  test("拒绝 /usr 子路径", () => {
    expect(validateWorkspacePath("/usr/local/bin")).toContain("系统目录");
  });

  test("接受合法路径", () => {
    expect(validateWorkspacePath("/home/user/project")).toBeNull();
  });

  test("接受 /tmp 子路径", () => {
    expect(validateWorkspacePath("/tmp/my-workspace")).toBeNull();
  });
});
