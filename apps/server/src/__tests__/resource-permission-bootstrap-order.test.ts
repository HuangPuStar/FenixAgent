import { expect, test } from "bun:test";
import { runCriticalStartupSequence } from "../bootstrap/startup-sequence";

// 权限仓库必须在模型网关读取 provider 授权前完成实际装配。
test("wires resource permissions after database initialization and before model gateway startup", async () => {
  const calls: string[] = [];

  await runCriticalStartupSequence({
    initDb: async () => calls.push("database"),
    wirePermissions: () => calls.push("permissions"),
    initModelGateway: async () => calls.push("model-gateway"),
  });

  expect(calls).toEqual(["database", "permissions", "model-gateway"]);
});
