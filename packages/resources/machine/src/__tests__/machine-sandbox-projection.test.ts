import { expect, test } from "bun:test";
import {
  markSandboxInstanceReadyForMachine,
  touchSandboxInstanceHeartbeatForMachine,
} from "@fenix/resource-machine/server";

// Machine 侧必须拥有 Sandbox ready 投影，避免注册链反向依赖 Sandbox 资源模块。
test("Machine Sandbox 投影公开 ready 与 heartbeat 更新能力", () => {
  expect(markSandboxInstanceReadyForMachine).toBeFunction();
  expect(touchSandboxInstanceHeartbeatForMachine).toBeFunction();
});
