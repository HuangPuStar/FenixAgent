/**
 * 机器生命周期通知端口（`MachineLifecyclePort`）的降级语义（§1.7 B4 前置）。
 *
 * 为什么单独一条：本端口与 `host-port.ts` 的语义**刻意相反**——host port 是宿主必提供的能力，未绑定
 * 即失败；本端口「未绑定是正常状态」（assembly profile 可以不含沙盒模块，那时机器事件没有受体）。
 * 这条差异此前只有注释在说，没有用例在钉：把两个调用点的可选链（`getMachineLifecyclePort()?.notifyX`）
 * 改成非空断言、或让读取在未绑定时抛错，全套用例仍然全绿——`round36` / `round68` 都在 `beforeEach`
 * 里绑了记录器，**没有一条用例跑在「未绑定」这个状态下**。
 *
 * 于是这里补的就是那个缺失的状态：未绑定时注册与心跳路径都必须照常完成（通知是可选副作用，缺受体不能
 * 反过来让业务路径失败）。顺带把绑定守卫的两条语义也钉住，避免「二次绑定」的判据被误改。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { initializeMachineModuleConfig } from "../server/testing";

const registry = await import("@fenix/resource-machine/server");

function chain(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({ limit: async () => rows, orderBy: () => ({ limit: () => ({ offset: async () => rows }) }) }),
    }),
  };
}

function mutation(calls: unknown[]) {
  return () => ({ set: (value: unknown) => ({ where: async () => calls.push(value) }) });
}

function insert(calls: unknown[]) {
  return () => ({ values: async (value: unknown) => calls.push(value) });
}

/** 只用于绑定守卫用例的替身；两个方法都不被调用。 */
const noopPort = {
  notifyMachineRegistered: async () => {},
  notifyMachineHeartbeat: async () => {},
};

beforeEach(() => {
  initializeMachineModuleConfig();
  // 本文件测的就是「未绑定」，因此显式复位——同进程的其它文件可能刚绑过记录器。
  registry.resetMachineLifecyclePortForTest();
});

afterEach(() => {
  // 复位必须写在 afterEach：只靠下一条用例的 beforeEach 清理，端口会在文件之间带着上一个文件的实现
  // 存活（模块级单例，Bun 同进程跑完整个包），掩盖降级行为并造成顺序相关的假绿。
  registry.resetMachineLifecyclePortForTest();
  registry.resetRegistryHeartbeatDeps();
  resetAllStubs();
});

describe("机器生命周期通知端口", () => {
  // 端口未装配时读取返回 null：调用方据此走「无沙盒能力」分支，与 host port 的「未绑定即失败」刻意不同。
  test("未绑定时读取返回 null", () => {
    expect(registry.getMachineLifecyclePort()).toBeNull();
  });

  // 机器注册在无人收听时必须照常完成：通知是可选副作用，缺受体不能让注册失败。
  test("未绑定端口时机器注册照常完成", async () => {
    const updates: unknown[] = [];
    const writes: unknown[] = [];
    stubDb({
      select: () => chain([{ id: "mach-no-port", status: "offline" }]),
      update: mutation(updates),
      insert: insert(writes),
    });

    await expect(
      registry.registerMachine({ agentName: "opencode", tenantId: "org-a", machineId: "mach-no-port" }),
    ).resolves.toEqual({ id: "mach-no-port", isNew: false });
  });

  // 心跳路径同理：本包只更新机器活跃时间，实例投影由沙盒侧写，缺受体不影响心跳本身。
  test("未绑定端口时心跳路径照常完成", async () => {
    const updateHeartbeat = mock(async () => {});
    registry.setRegistryHeartbeatDeps({ updateHeartbeat });

    await expect(registry.handleHeartbeat("mach-no-port")).resolves.toBeUndefined();

    expect(updateHeartbeat).toHaveBeenCalledWith("mach-no-port");
  });

  // 装配期二次绑定**不同**实现必须报错：两套实现抢同一批实例行会让投影互相覆盖。
  test("二次绑定不同实现被拒绝", () => {
    registry.bindMachineLifecyclePort(noopPort);

    expect(() => registry.bindMachineLifecyclePort({ ...noopPort })).toThrow(
      "MachineLifecyclePort has already been bound",
    );
  });

  // 重复绑定**同一引用**必须放行：端口是幂等的装配点，装配流程重入不应因此中断。
  test("重复绑定同一实现放行", () => {
    registry.bindMachineLifecyclePort(noopPort);

    expect(() => registry.bindMachineLifecyclePort(noopPort)).not.toThrow();
  });
});
