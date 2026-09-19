import { expect, test } from "bun:test";
import { runCriticalStartupSequence } from "../bootstrap/startup-sequence";

// 授权端口必须在模型网关读取 provider 授权前完成装配。
//
// 该不变量随旧授权栈下线未变、但含义变了：`wirePermissions` 现在装配的是 `createDrizzleAccessControl`
// 与四个资源模块（mcp / skill / agent-config / model-management），它们都必须早于
// `initModelGateway`——模型网关启动即查询 provider 授权。
test("wires access control ports after database initialization and before model gateway startup", async () => {
  const calls: string[] = [];

  await runCriticalStartupSequence({
    initDb: async () => calls.push("database"),
    wirePermissions: () => calls.push("access-control"),
    initModelGateway: async () => calls.push("model-gateway"),
  });

  expect(calls).toEqual(["database", "access-control", "model-gateway"]);
});
