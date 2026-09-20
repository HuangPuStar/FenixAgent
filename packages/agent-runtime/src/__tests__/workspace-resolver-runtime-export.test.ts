import { expect, test } from "bun:test";
import { resolveWorkspacePath } from "@fenix/agent-runtime/server";

// 宿主装配层经公开 server 边界取本包的 workspace 路径解析，用作 Machine 的宿主 port 实现
// （`apps/server/src/main.ts:286` 把它绑给 `bindMachineHostPort`）。改这条注释时注意：1.4 W5 之后
// Machine 已不导入本包，消费方是宿主组合根；行为断言在 `workspace-resolver.test.ts`，本用例只钉公开可达性。
test("runtime server 公开 workspace 路径解析", () => {
  expect(resolveWorkspacePath("org-a", "user-a", "env-a")).toContain("org-a/user-a/env-a");
});
