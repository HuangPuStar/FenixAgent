import { expect, test } from "bun:test";
import { resolveWorkspacePath } from "@fenix/agent-runtime/server";

// Machine 只能经 runtime 的公开 server 边界复用 Environment 工作区路径规则。
test("runtime server 公开 workspace 路径解析", () => {
  expect(resolveWorkspacePath("org-a", "user-a", "env-a")).toContain("org-a/user-a/env-a");
});
