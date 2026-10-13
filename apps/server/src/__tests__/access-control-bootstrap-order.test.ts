import { expect, test } from "bun:test";
import { runCriticalStartupSequence } from "../bootstrap/startup-sequence";

// 授权端口必须在模型网关读取 provider 授权前完成装配。
//
// 该不变量在授权栈两代实现下都成立，只是承担者变了：`wirePermissions` 现在跑的是 registry 装配
// （`bootstrapServerAssembly`），它按 profile 拓扑序 create 各模块——access-control 汇总各资源模块声明的
// 存储绑定并建立授权查询，四个受控资源模块随后装入进程级槽位。模型网关启动即查询 provider 授权，因此
// 装配必须晚于 `initDb`（装配期调用 `getDatabase()`）、早于 `initModelGateway`。
test("wires access control ports after database initialization and before model gateway startup", async () => {
  const calls: string[] = [];

  await runCriticalStartupSequence({
    initDb: async () => calls.push("database"),
    wirePermissions: async () => {
      calls.push("access-control");
    },
    initModelGateway: async () => calls.push("model-gateway"),
  });

  expect(calls).toEqual(["database", "access-control", "model-gateway"]);
});
