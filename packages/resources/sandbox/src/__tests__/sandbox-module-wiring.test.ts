/**
 * Sandbox 组合根的**装配接线**覆盖（§1.7 B4 前置）。
 *
 * 为什么需要单独一条：那次重构把「机器事件 → 沙盒实例投影」拆成了三段——machine 通报事件、sandbox 实现
 * 投影、`createSandboxModule()` 把两者接起来。前两段各自有用例（machine 的 `round36` / `round68`、
 * 本包的 `sandbox-instance-machine-projection`），但**中间那一行接线此前无人覆盖**：把两个通知对调、
 * 或整段换成空实现，全套用例仍然全绿，而生产里机器注册与心跳不再投影，
 * `creating` / `starting` / `recovering` 的实例会永久停在中间态（`sandboxManager.recoverAfterRestart()`
 * 的恢复链正是靠这条投影闭环）。
 *
 * 因此这里断言的是**函数同一性**而不是「端口非空」：`toBe` 钉住绑定的是本包仓储的那两个函数本身。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import {
  getMachineLifecyclePort,
  getMachineSandboxRoutePort,
  resetMachineLifecyclePortForTest,
  resetMachineSandboxRoutePortForTest,
} from "@fenix/resource-machine/server";
import { createSandboxModule } from "../module";
import {
  markSandboxInstancesReadyForMachine,
  touchSandboxInstancesHeartbeatByMachine,
} from "../server/repositories/sandbox-instance-repository";
import { resolveSandboxMachineRoute } from "../server/services/sandbox-machine-route";

describe("Sandbox 模块的装配接线", () => {
  beforeEach(() => {
    // 端口是进程级单例：先清空，避免用例之间或与同进程其它文件互相影响（绑定守卫会拒绝二次绑定）。
    resetMachineLifecyclePortForTest();
    resetMachineSandboxRoutePortForTest();
  });

  afterEach(() => {
    resetMachineLifecyclePortForTest();
    resetMachineSandboxRoutePortForTest();
    resetAllStubs();
  });

  // 组合根是唯一让机器事件真正落到本包表上的地方：绑定必须指向本包仓储的两个投影函数。
  test("createSandboxModule 把机器生命周期通知绑定到本包的投影实现", () => {
    createSandboxModule();

    const port = getMachineLifecyclePort();
    expect(port?.notifyMachineRegistered).toBe(markSandboxInstancesReadyForMachine);
    expect(port?.notifyMachineHeartbeat).toBe(touchSandboxInstancesHeartbeatByMachine);
  });

  // 同一性之外的端到端旁证：经端口通报一次，写出的载荷必须与仓储自己的投影逐字一致——防「绑了个包装层
  // 但里面什么也没做」这类绕开同一性断言的改法。
  test("经端口通报的机器注册真的写到本包的表上", async () => {
    createSandboxModule();
    const payloads: Record<string, unknown>[] = [];
    stubDb({
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            payloads.push(values);
          },
        }),
      }),
    });
    const at = new Date("2026-09-22T00:00:00.000Z");

    await getMachineLifecyclePort()?.notifyMachineRegistered("mach_1", at);

    expect(payloads).toEqual([{ status: "ready", lastHeartbeatAt: at, updatedAt: at }]);
  });

  // 「环境该路由到哪台机器」的判定同批绑定：本包是它的实现方，未绑定则 machine 按「无沙盒能力」降级。
  test("createSandboxModule 把沙盒路由判定绑定到本包实现", () => {
    createSandboxModule();

    expect(getMachineSandboxRoutePort()?.resolveSandboxRoute).toBe(resolveSandboxMachineRoute);
  });
});
