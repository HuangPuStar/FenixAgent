import { expect, test } from "bun:test";
import { markSandboxInstanceReadyForMachine } from "@fenix/resource-machine/server";

// Sandbox 只能通过 Machine 资源包获取由 Machine 事件驱动的状态投影能力。
test("Machine 资源包公开 Sandbox 状态投影", () => {
  expect(markSandboxInstanceReadyForMachine).toBeFunction();
});
