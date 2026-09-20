import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentRuntimePort, AgentRuntimeSessionApi } from "../runtime";
import {
  bindAgentRuntime,
  createAgentRuntime,
  createAgentRuntimeModule,
  getBoundAgentRuntime,
  resetAgentRuntimeForTest,
} from "../runtime";

/**
 * 管理面 42 个方法与数据面 6 个方法的清单。
 *
 * `satisfies` 让「清单里写了 port 上不存在的名字」在编辑期就报错，运行期断言再确认实现对象
 * 一个不少、两个面不互相错位。改动 port 面时这张清单会一起失败——这正是契约测试的目的：
 * 让公开面的每一次增删都必须显式落到测试上。
 */
const PORT_METHODS = [
  // 启动
  "ensureInstance",
  "ensureInstanceRuntime",
  "findOrCreateDefaultInstance",
  "findOrCreateWorkflowInstanceWithStatus",
  "createInstance",
  "createEnvironment",
  "updateEnvironment",
  "restartActiveInstancesForEnvironments",
  "openAgentSession",
  "setRuntimeCredentialResolver",
  // 停止
  "stopInstance",
  "stopInstanceRuntime",
  "restartInstanceRuntime",
  "deleteInstance",
  "stopInstancesForEnvironments",
  "deleteEnvironment",
  "closeAcpConnectionsForEnvironments",
  "closeAllAcpConnections",
  "closeAllRelayConnections",
  // 状态
  "getOwnedEnvironment",
  "listEnvironments",
  "getEnvironmentBySecret",
  "findRunningInstanceByEnvironment",
  "listRuntimeInstances",
  "getRuntimeInstance",
  "getOwnedInstance",
  "listOwnedInstances",
  "getRuntimeSnapshot",
  "listInstanceActivity",
  "touchInstanceActivity",
  "markInstanceRelayAttached",
  "markInstanceRelayDetached",
  "refreshInstanceEnvironment",
  "getSession",
  "resolveExistingSessionId",
  "updateSessionStatus",
  // 回收
  "cleanupInstancesForMachine",
  "unregisterInstance",
  "terminateLocalDeadInstance",
  "startIdleMonitor",
  "stopIdleMonitor",
  "shutdown",
] as const satisfies readonly (keyof AgentRuntimePort)[];

const SESSION_METHODS = [
  "connectRelay",
  "createAgentSession",
  "createPromptTurn",
  "startPromptTurn",
  "sendToAgentWs",
  "sendToInstanceRelay",
] as const satisfies readonly (keyof AgentRuntimeSessionApi)[];

afterEach(() => {
  // 装配状态是模块级单例：用例结束要把**真实入口**装回去，而不是留空。消费方（宿主路由、编排层、
  // 资源包）一律经 `getBoundAgentRuntime()` 取值，留空会让同进程后续测试文件在调用点报「未绑定」
  //（`bun test packages/` 在同进程顺序跑全部文件，实测 round57 因此失败）。
  resetAgentRuntimeForTest();
  bindAgentRuntime(createAgentRuntime());
});

describe("AgentRuntime port 契约", () => {
  // 公开的运行入口必须与清单逐名一致：既不缺项，也不留未登记的第二入口。
  test("管理面与数据面的方法集合与清单完全一致", () => {
    const runtime = createAgentRuntime();

    expect(new Set(Object.keys(runtime))).toEqual(new Set([...PORT_METHODS, "session"]));
    expect(new Set(Object.keys(runtime.session))).toEqual(new Set(SESSION_METHODS));

    for (const name of PORT_METHODS) {
      expect(typeof runtime[name]).toBe("function");
    }
    for (const name of SESSION_METHODS) {
      expect(typeof runtime.session[name]).toBe("function");
    }
  });

  // 同一能力不得在两个面各留一份：重复入口会让消费方无从判断该用哪一个。
  test("管理面与数据面不共享方法名", () => {
    const overlap = PORT_METHODS.filter((name) => (SESSION_METHODS as readonly string[]).includes(name));
    expect(overlap).toEqual([]);
  });

  // 未装配即失败：隐式构造第二套入口会让消费方在宿主装配未完成时拿到半可用的 runtime。
  test("未绑定时取用运行入口直接失败", () => {
    resetAgentRuntimeForTest();

    expect(() => getBoundAgentRuntime()).toThrow("AgentRuntime has not been bound");
  });

  // 一次装配全局共享：重复绑定不同实例意味着进程内存在两套绑定状态，排查时无法区分哪一套在生效。
  test("绑定后可取用，重复绑定不同实例失败", () => {
    resetAgentRuntimeForTest();
    const first = createAgentRuntime();
    bindAgentRuntime(first);
    expect(getBoundAgentRuntime()).toBe(first);

    expect(() => bindAgentRuntime(createAgentRuntime())).toThrow("AgentRuntime has already been bound");
    expect(getBoundAgentRuntime()).toBe(first);
  });

  // 模块工厂幂等：registry 装配可能多次求值，重复创建不得产生第二份运行状态。
  test("模块工厂重复调用返回同一入口并完成绑定", () => {
    const created = createAgentRuntimeModule();
    const again = createAgentRuntimeModule();

    expect(created.id).toBe("agent-runtime");
    expect(again.runtime).toBe(created.runtime);
    expect(getBoundAgentRuntime()).toBe(created.runtime);
  });

  // port 是宿主装配面的对侧，不得经本包公开 barrel 自引用——自引用会让 `./server` 既是内部实现
  // 又被当作外部契约，收窄公开面时无法判断谁是消费者。
  test("runtime 入口不经 server barrel 自引用", () => {
    const source = readFileSync(resolve(import.meta.dir, "../runtime.ts"), "utf8");

    expect(source).not.toContain('from "./server"');
    expect(source).not.toContain("@fenix/agent-runtime/server");
  });
});
