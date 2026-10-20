import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  handleAcpWsClose,
  handleAcpWsOpen,
  handleExternalRelayClose,
  handleExternalRelayOpen,
  listAcpConnections,
  listExternalRelayEntries,
  setExternalRelayDeps,
} from "@fenix/agent-runtime/server/testing";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { createRelayHandle, createWs, makeSpawnedInstance, type TestAuthContext } from "./observer-fixtures";

describe("observer connection snapshot", () => {
  beforeEach(() => resetAllStubs());
  afterEach(() => {
    setExternalRelayDeps(null);
    resetAllStubs();
  });
  // 集成：走真实 open 流程后快照 getter 返回字段正确，且不暴露 ws/unsub/keepalive 句柄
  test("集成：真实 listAcpConnections / listExternalRelayEntries 快照", async () => {
    // acp-ws：machine + 本地链接
    const machineWs = createWs();
    const localWs = createWs();
    handleAcpWsOpen(machineWs, "ws_m1", "__machine__", null, true);
    handleAcpWsOpen(localWs, "ws_l1", "user-1", "env-1", false);

    const snapshots = listAcpConnections();
    const machineSnap = snapshots.find((snap) => snap.wsId === "ws_m1")!;
    expect(machineSnap).toBeDefined();
    expect(machineSnap.isMachine).toBe(true);
    expect(machineSnap.machineId).toBeNull();
    expect(machineSnap.userId).toBe("__machine__");
    const localSnap = snapshots.find((snap) => snap.wsId === "ws_l1")!;
    expect(localSnap.boundEnvId).toBe("env-1");
    // 快照不暴露 ws/unsub/keepalive 等句柄字段
    for (const snap of snapshots) {
      expect("ws" in snap).toBe(false);
      expect("unsub" in snap).toBe(false);
      expect("keepalive" in snap).toBe(false);
    }
    // 清理连接（清除 keepalive interval 与 entries），避免测试进程悬挂
    handleAcpWsClose(machineWs, "ws_m1");
    handleAcpWsClose(localWs, "ws_l1");

    // external-relay：stub deps 走真实 open → 快照含 agentId/authContext/openTime
    setExternalRelayDeps({
      getEnvironmentById: async () => ({ id: "env-1", organizationId: "org-1", userId: "user-1" }),
      getOwnedInstance: async (id, ownerUserId) => ({
        id,
        ownerUserId,
        environmentId: "env-1",
        creationSource: "api",
        name: "primary",
        isDefault: false,
        createdByUserId: ownerUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      getRunningInstancesByEnvironment: () => [makeSpawnedInstance("inst-1")],
      connectAgentRelay: async () => createRelayHandle(),
      markRelayAttached: () => {},
      markRelayDetached: () => {},
      touchActivity: () => {},
    });
    const relayWs = createWs();
    const authCtx: TestAuthContext = { organizationId: "org-1", userId: "user-1", role: "owner" };
    await handleExternalRelayOpen(relayWs, "ext_relay_1", "env-1", authCtx, "inst-1");

    expect(listExternalRelayEntries()).toEqual([
      {
        relayWsId: "ext_relay_1",
        agentId: "env-1",
        instanceId: "inst-1",
        organizationId: "org-1",
        userId: "user-1",
        openTime: expect.any(Number),
      },
    ]);
    handleExternalRelayClose(relayWs, "ext_relay_1");
  });
});
