import { afterEach, expect, test } from "bun:test";
import type { RuntimeInstanceSnapshot } from "@fenix/core";
import type { AgentController } from "@fenix/orchestration";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import { stubCoreRuntimeFacade } from "../server/testing";
import { connectAgentRelay } from "../server/transport/agent-relay";
import { resetOrchestrationInstanceDeps, setOrchestrationInstanceDeps } from "../services/orchestration-instance";

function snapshot(generation: number): RuntimeInstanceSnapshot {
  return {
    instanceId: "inst_death_identity",
    nodeId: "local-default",
    status: "running",
    runtimeGeneration: generation,
    serverEpoch: "death-test-epoch",
  } as RuntimeInstanceSnapshot;
}

function fixture() {
  let current = snapshot(1);
  let receive: ((message: EngineRelayMessage) => void) | undefined;
  const reclaimed: number[] = [];
  const handle: EngineRelayHandle = {
    state: "open",
    send() {},
    close() {},
    onMessage(listener) {
      receive = listener;
      return () => {
        receive = undefined;
      };
    },
  };
  stubCoreRuntimeFacade({
    getInstance: () => current,
    connectInstanceRelay: async () => handle,
  });
  setOrchestrationInstanceDeps({
    getOrchestrationController: () =>
      ({ listInstances: () => [{ instanceId: current.instanceId }] }) as unknown as AgentController,
    async reclaimRuntime(_instanceId, generation) {
      if (generation !== undefined) reclaimed.push(generation);
    },
  });
  return {
    reclaimed,
    handle,
    advance() {
      current = snapshot(2);
    },
    emitClosed() {
      receive?.({ type: "relay_closed" });
    },
  };
}

afterEach(() => {
  resetOrchestrationInstanceDeps();
  resetAllStubs();
});

// 旧运行代次的连接晚失败时，不得把连接开始后的新实体当成死亡目标。
test("旧连接建连失败不回收同 UID 新代实例", async () => {
  const setup = fixture();
  let rejectConnection: (reason: Error) => void = () => {};
  const pending = new Promise<EngineRelayHandle>((_resolve, reject) => {
    rejectConnection = reject;
  });
  stubCoreRuntimeFacade({ getInstance: () => snapshot(1), connectInstanceRelay: () => pending });
  const connecting = connectAgentRelay("inst_death_identity", "session");
  setup.advance();
  stubCoreRuntimeFacade({ getInstance: () => snapshot(2) });
  rejectConnection(new Error("old runtime disconnected"));
  await expect(connecting).rejects.toThrow("old runtime disconnected");
  expect(setup.reclaimed).toEqual([]);
});

// 旧运行代次的迟到 relay_closed 只能清理其捕获身份，不能停止已重启的实体。
test("旧 relay 的迟到关闭不回收新代实例", async () => {
  const setup = fixture();
  await connectAgentRelay("inst_death_identity", "session");
  setup.advance();
  setup.emitClosed();
  await Bun.sleep(0);
  expect(setup.reclaimed).toEqual([]);
});

// 当前实体的 relay 关闭必须从连接工厂进入统一生命周期回收，确保下次 ensure 可恢复。
test("当前 relay 关闭按捕获运行代次回收", async () => {
  const setup = fixture();
  await connectAgentRelay("inst_death_identity", "session");
  setup.emitClosed();
  await Bun.sleep(0);
  expect(setup.reclaimed).toEqual([1]);
});
