import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AuthContext } from "../plugins/auth";
import {
  buildRelationTree,
  type Observation,
  ObserverKindNotFoundError,
  observerService,
  setObserverServiceDeps,
} from "../services/observer";
import { resetAllStubs, stubEnvironmentRepo } from "../test-utils/helpers";
import {
  createRelayHandle,
  createWs,
  makeAcpWsLocal,
  makeAcpWsMachine,
  makeChat,
  makeEnv,
  makeFakeDeps,
  makeRelay,
  makeSpawnedInstance,
} from "../test-utils/observer-fixtures";
import { handleAcpWsClose, handleAcpWsOpen, listAcpConnections } from "../transport/acp-ws-handler";
import {
  handleExternalRelayClose,
  handleExternalRelayOpen,
  listExternalRelayEntries,
  setExternalRelayDeps,
} from "../transport/relay/external-relay";

describe("observer-service", () => {
  beforeEach(() => {
    resetAllStubs();
    setObserverServiceDeps(makeFakeDeps());
  });
  afterEach(() => {
    setObserverServiceDeps(null);
    setExternalRelayDeps(null);
  });

  // 注册表路由：acp-link 已注册、未知 kind 返回 undefined（文档 §2.3 可摘除回滚的前提）
  test("provider 注册表：acp-link 已注册，未知 kind 返回 undefined", () => {
    expect(observerService.provider("acp-link")).toBeDefined();
    expect(observerService.provider("workflow-run")).toBeUndefined();
  });

  // 未注册 kind 查询必须明确失败，路由据此映射 404，而非静默返回空视图
  test("未知 kind 的 tree/list 抛 ObserverKindNotFoundError", async () => {
    await expect(observerService.tree("workflow-run")).rejects.toBeInstanceOf(ObserverKindNotFoundError);
    await expect(observerService.list("workflow-run")).rejects.toBeInstanceOf(ObserverKindNotFoundError);
  });

  // machine 连接计入 total 并在 machine 树体现，哨兵 userId 不作为角色输出（Q3 默认）
  test("machine 来源观察行与 machine 树", async () => {
    setObserverServiceDeps(makeFakeDeps({ listAcpWsConnections: () => [makeAcpWsMachine()] }));

    const list = await observerService.list("acp-link");
    expect(list).toHaveLength(1);
    const obs = list[0];
    expect(obs.id).toBe("acp-ws:ws_m1");
    expect(obs.entityIds).toEqual([
      { role: "linkId", id: "acp-ws:ws_m1" },
      { role: "machineId", id: "mach_x" },
    ]);
    // 路由层传入的 "__machine__" 哨兵 userId 不作为真实角色输出
    expect(obs.entityIds.some((entry) => entry.role === "userId")).toBe(false);
    expect(obs.verified).toBe(true);
    expect(obs.payload?.source).toBe("acp-ws");
    expect(obs.payload?.capabilities).toEqual({ hello: true });

    const view = await observerService.tree("acp-link");
    expect(view.total).toBe(1);
    expect(view.byOrg).toEqual([]);
    expect(view.byEntity).toEqual([
      { machineId: "mach_x", count: 1, leaves: [{ id: "acp-ws:ws_m1", source: "acp-ws", roleId: "mach_x" }] },
    ]);
  });

  // machine 注册前 machineId 为 null：关键角色缺省必须 verified=false 且计入 integrity
  test("machine 注册前：machineId 省略且 verified=false", async () => {
    setObserverServiceDeps(makeFakeDeps({ listAcpWsConnections: () => [makeAcpWsMachine({ machineId: null })] }));

    const obs = (await observerService.list("acp-link"))[0];
    expect(obs.entityIds).toEqual([{ role: "linkId", id: "acp-ws:ws_m1" }]);
    expect(obs.verified).toBe(false);

    const view = await observerService.tree("acp-link");
    expect(view.integrity.checked).toBe(1);
    expect(view.integrity.mismatched).toBe(1);
    expect(view.integrity.mismatchedItems).toEqual([{ kind: "acp-link", id: "acp-ws:ws_m1" }]);
    expect(view.byEntity).toEqual([]);
  });

  // 本地链接经 env 权威回查补齐角色；identify 前 agentConfigId 为 null 则不占位
  test("本地 acp-link 角色补齐与 agentConfigId 省略", async () => {
    setObserverServiceDeps(
      makeFakeDeps({
        listAcpWsConnections: () => [makeAcpWsLocal()],
        getDefaultMachineId: () => "mach_default",
      }),
    );
    stubEnvironmentRepo({ getById: async () => makeEnv() });

    const obs = (await observerService.list("acp-link"))[0];
    expect(obs.entityIds).toEqual([
      { role: "linkId", id: "acp-ws:ws_l1" },
      { role: "userId", id: "user-1" },
      { role: "organizationId", id: "org-1" },
      { role: "agentConfigId", id: "acfg-1" },
      { role: "machineId", id: "mach_default" },
    ]);
    expect(obs.verified).toBe(true);

    // env.agentConfigId 为 null → agentConfigId 角色省略（identify 前不占位）
    stubEnvironmentRepo({ getById: async () => makeEnv({ agentConfigId: null }) });
    const obsNoCfg = (await observerService.list("acp-link"))[0];
    expect(obsNoCfg.entityIds.some((entry) => entry.role === "agentConfigId")).toBe(false);
    expect(obsNoCfg.entityIds.some((entry) => entry.role === "organizationId")).toBe(true);
  });

  // env 权威记录缺失：org/agentConfigId 无从回查，缺省不占位且 verified=false
  test("env 缺失：角色省略且 verified=false", async () => {
    setObserverServiceDeps(
      makeFakeDeps({
        listAcpWsConnections: () => [makeAcpWsLocal()],
        getDefaultMachineId: () => "mach_default",
      }),
    );
    stubEnvironmentRepo({ getById: async () => undefined });

    const obs = (await observerService.list("acp-link"))[0];
    expect(obs.entityIds.some((entry) => entry.role === "organizationId")).toBe(false);
    expect(obs.entityIds.some((entry) => entry.role === "agentConfigId")).toBe(false);
    expect(obs.entityIds.find((entry) => entry.role === "machineId")?.id).toBe("mach_default");
    expect(obs.verified).toBe(false);

    const view = await observerService.tree("acp-link");
    expect(view.integrity.mismatched).toBe(1);
    expect(view.integrity.mismatchedItems).toEqual([{ kind: "acp-link", id: "acp-ws:ws_l1" }]);
  });

  // 归属校验：本地链接 userId 与 env 权威值不一致时关系自证失败，verified=false
  test("本地 acp-link userId 不一致 → verified=false", async () => {
    setObserverServiceDeps(makeFakeDeps({ listAcpWsConnections: () => [makeAcpWsLocal({ userId: "user-2" })] }));
    stubEnvironmentRepo({ getById: async () => makeEnv({ userId: "user-1" }) });

    const obs = (await observerService.list("acp-link"))[0];
    expect(obs.verified).toBe(false);
  });

  // external-relay 按 open 时的放行语义校验：org 或 user 任一匹配即 verified=true，双不匹配为 false
  test("external-relay 字段映射与放行规则", async () => {
    setObserverServiceDeps(
      makeFakeDeps({
        listExternalRelayEntries: () => [makeRelay()],
        getAgentConfigById: async () => ({ machineId: "mach_1" }),
      }),
    );
    stubEnvironmentRepo({ getById: async () => makeEnv() });

    const obs = (await observerService.list("acp-link"))[0];
    expect(obs.id).toBe("external-relay:ext_relay_1");
    expect(obs.entityIds).toEqual([
      { role: "linkId", id: "external-relay:ext_relay_1" },
      { role: "userId", id: "user-1" },
      { role: "instanceId", id: "inst-1" },
      { role: "organizationId", id: "org-1" },
      { role: "agentConfigId", id: "acfg-1" },
      { role: "machineId", id: "mach_1" },
    ]);
    expect(obs.verified).toBe(true);
    expect(obs.payload).toEqual({ source: "external-relay", openTime: 3000 });

    // 双不匹配（org 与 user 都与 env 不一致）→ verified=false
    setObserverServiceDeps(
      makeFakeDeps({
        listExternalRelayEntries: () => [makeRelay({ organizationId: "org-x", userId: "user-x" })],
        getAgentConfigById: async () => ({ machineId: "mach_1" }),
      }),
    );
    stubEnvironmentRepo({ getById: async () => makeEnv() });
    const badObs = (await observerService.list("acp-link"))[0];
    expect(badObs.verified).toBe(false);
  });

  // chat-relay 客户端映射：instanceId/machineId 落角色，session 概要进 payload，未 load 不占位
  test("chat-relay 字段映射与 payload", async () => {
    setObserverServiceDeps(
      makeFakeDeps({
        listChatClients: () => [makeChat()],
        getAgentConfigById: async () => ({ machineId: "mach_1" }),
      }),
    );
    stubEnvironmentRepo({ getById: async () => makeEnv() });

    const obs = (await observerService.list("acp-link"))[0];
    expect(obs.id).toBe("chat-relay:yjs_1");
    expect(obs.entityIds.find((entry) => entry.role === "instanceId")?.id).toBe("inst-1");
    expect(obs.entityIds.find((entry) => entry.role === "machineId")?.id).toBe("mach_1");
    expect(obs.payload).toEqual({
      source: "chat-relay",
      rcsSessionId: "rcs_1",
      acpSessionId: "ses_1",
      openTime: 4000,
    });
    expect(obs.verified).toBe(true);

    // acpSessionId 为 null（未 load_session）→ payload 省略该字段
    setObserverServiceDeps(
      makeFakeDeps({
        listChatClients: () => [makeChat({ acpSessionId: null })],
        getAgentConfigById: async () => ({ machineId: "mach_1" }),
      }),
    );
    stubEnvironmentRepo({ getById: async () => makeEnv() });
    const obsNoSession = (await observerService.list("acp-link"))[0];
    expect(obsNoSession.payload?.acpSessionId).toBeUndefined();
  });

  // machine 归属解析链：agentConfig.machineId 优先 → RCS_DEFAULT_MACHINE_ID 兜底 → 两者皆无则省略
  test("machine 解析链：agentConfig.machineId → default → 省略", async () => {
    stubEnvironmentRepo({ getById: async () => makeEnv() });

    // agentConfig.machineId 优先于 default
    setObserverServiceDeps(
      makeFakeDeps({
        listChatClients: () => [makeChat()],
        getAgentConfigById: async () => ({ machineId: "mach_cfg" }),
        getDefaultMachineId: () => "mach_default",
      }),
    );
    let obs = (await observerService.list("acp-link"))[0];
    expect(obs.entityIds.find((entry) => entry.role === "machineId")?.id).toBe("mach_cfg");

    // agentConfig 无 machineId → default 兜底
    setObserverServiceDeps(
      makeFakeDeps({
        listChatClients: () => [makeChat()],
        getAgentConfigById: async () => null,
        getDefaultMachineId: () => "mach_default",
      }),
    );
    obs = (await observerService.list("acp-link"))[0];
    expect(obs.entityIds.find((entry) => entry.role === "machineId")?.id).toBe("mach_default");

    // 两者皆无 → machineId 角色省略
    setObserverServiceDeps(
      makeFakeDeps({
        listChatClients: () => [makeChat()],
        getAgentConfigById: async () => null,
        getDefaultMachineId: () => null,
      }),
    );
    obs = (await observerService.list("acp-link"))[0];
    expect(obs.entityIds.some((entry) => entry.role === "machineId")).toBe(false);
  });

  // linkId 按「source:连接id」归一化，三类来源 id 前缀天然不同，全局唯一且自描述
  test("linkId 归一化：source + 来源连接 id", async () => {
    setObserverServiceDeps(
      makeFakeDeps({
        listAcpWsConnections: () => [makeAcpWsMachine({ wsId: "acp_ws_1a2b3c" })],
        listExternalRelayEntries: () => [makeRelay({ relayWsId: "ext_relay_xyz" })],
        listChatClients: () => [makeChat({ wsId: "yjs_abc" })],
        getAgentConfigById: async () => ({ machineId: "mach_1" }),
      }),
    );
    stubEnvironmentRepo({ getById: async () => makeEnv() });

    const ids = (await observerService.list("acp-link")).map((o) => o.id).sort();
    expect(ids).toEqual(["acp-ws:acp_ws_1a2b3c", "chat-relay:yjs_abc", "external-relay:ext_relay_xyz"]);
  });

  // 归属树逐层计数正确；无实例的叶子落 AgentNodeView.leaves；无 org 的 machine 只进 machine 树
  test("树计数与 AgentNodeView.leaves 归属", () => {
    const observations: Observation[] = [
      {
        id: "external-relay:r1",
        kind: "acp-link",
        source: "external-relay",
        ts: 1,
        entityIds: [
          { role: "organizationId", id: "org-1" },
          { role: "userId", id: "user-1" },
          { role: "agentConfigId", id: "acfg-1" },
          { role: "instanceId", id: "inst-1" },
          { role: "linkId", id: "external-relay:r1" },
          { role: "machineId", id: "mach_1" },
        ],
        verified: true,
      },
      {
        id: "acp-ws:ws_l1",
        kind: "acp-link",
        source: "acp-ws",
        ts: 2,
        entityIds: [
          { role: "organizationId", id: "org-1" },
          { role: "userId", id: "user-1" },
          { role: "agentConfigId", id: "acfg-1" },
          { role: "linkId", id: "acp-ws:ws_l1" },
        ],
        verified: true,
      },
      {
        id: "external-relay:r2",
        kind: "acp-link",
        source: "external-relay",
        ts: 3,
        entityIds: [
          { role: "organizationId", id: "org-1" },
          { role: "userId", id: "user-1" },
          { role: "agentConfigId", id: "acfg-2" },
          { role: "instanceId", id: "inst-2" },
          { role: "linkId", id: "external-relay:r2" },
        ],
        verified: true,
      },
      {
        id: "acp-ws:ws_m1",
        kind: "acp-link",
        source: "acp-ws",
        ts: 4,
        entityIds: [
          { role: "linkId", id: "acp-ws:ws_m1" },
          { role: "machineId", id: "mach_2" },
        ],
        verified: true,
      },
    ];

    const view = buildRelationTree("acp-link", observations);
    expect(typeof view.generatedAt).toBe("string");
    expect(view.total).toBe(4);

    // byOrg 只有 org-1（machine 无 org 不进 byOrg）
    expect(view.byOrg).toHaveLength(1);
    const org = view.byOrg[0];
    expect(org.organizationId).toBe("org-1");
    expect(org.userCount).toBe(1);
    expect(org.agentCount).toBe(2);
    expect(org.instanceCount).toBe(2);
    expect(org.leafCount).toBe(3);

    const user = org.children[0];
    expect(user.userId).toBe("user-1");
    expect(user.agentCount).toBe(2);
    expect(user.leafCount).toBe(3);

    const agent1 = user.children.find((a) => a.agentConfigId === "acfg-1")!;
    expect(agent1.instanceCount).toBe(1);
    expect(agent1.leafCount).toBe(2);
    expect(agent1.children).toHaveLength(1);
    expect(agent1.children[0].instanceId).toBe("inst-1");
    expect(agent1.children[0].leafCount).toBe(1);
    expect(agent1.children[0].leaves[0].id).toBe("external-relay:r1");
    // 无 instance 的本地 acp-link 叶子落在 AgentNodeView.leaves
    expect(agent1.leaves).toHaveLength(1);
    expect(agent1.leaves![0]).toEqual({ id: "acp-ws:ws_l1", source: "acp-ws", machineId: null });

    const agent2 = user.children.find((a) => a.agentConfigId === "acfg-2")!;
    expect(agent2.instanceCount).toBe(1);
    expect(agent2.leafCount).toBe(1);
    expect(agent2.leaves).toBeUndefined();

    // byEntity：mach_1 与 mach_2 各 1 leaf；无 machineId 的 r2 不进 machine 树
    expect(view.byEntity).toEqual([
      {
        machineId: "mach_1",
        count: 1,
        leaves: [{ id: "external-relay:r1", source: "external-relay", roleId: "mach_1" }],
      },
      { machineId: "mach_2", count: 1, leaves: [{ id: "acp-ws:ws_m1", source: "acp-ws", roleId: "mach_2" }] },
    ]);
  });

  // integrity 汇总只含 kind+id 明细；checked=total，mismatched 与明细一一对应
  test("integrity 汇总：checked/mismatched/mismatchedItems", () => {
    const observations: Observation[] = [
      {
        id: "acp-ws:a",
        kind: "acp-link",
        source: "acp-ws",
        ts: 1,
        entityIds: [{ role: "linkId", id: "acp-ws:a" }],
        verified: true,
      },
      {
        id: "acp-ws:b",
        kind: "acp-link",
        source: "acp-ws",
        ts: 2,
        entityIds: [{ role: "linkId", id: "acp-ws:b" }],
        verified: false,
      },
      {
        id: "acp-ws:c",
        kind: "acp-link",
        source: "acp-ws",
        ts: 3,
        entityIds: [{ role: "linkId", id: "acp-ws:c" }],
      },
    ];

    const view = buildRelationTree("acp-link", observations);
    expect(view.total).toBe(3);
    expect(view.integrity.checked).toBe(3);
    expect(view.integrity.mismatched).toBe(1);
    expect(view.integrity.mismatchedItems).toEqual([{ kind: "acp-link", id: "acp-ws:b" }]);
  });

  // names 字典：各角色 id 经权威表批量解析名称，instance 名 = environment 名 + 序号
  test("names 字典：各角色名称解析", async () => {
    setObserverServiceDeps(
      makeFakeDeps({
        listExternalRelayEntries: () => [makeRelay()],
        listChatClients: () => [makeChat()],
        getAgentConfigById: async () => ({ machineId: "mach_1" }),
        getInstanceSupplement: () => ({ environmentId: "env-1", instanceNumber: 2 }),
        listOrganizationNamesByIds: async () => new Map([["org-1", "Acme 组织"]]),
        listUserNamesByIds: async () => new Map([["user-1", "张三"]]),
        listAgentConfigNamesByIds: async () => new Map([["acfg-1", "客服助手"]]),
        listMachineNamesByIds: async () => new Map([["mach_1", "边缘节点-01"]]),
      }),
    );
    stubEnvironmentRepo({ getById: async () => makeEnv({ name: "生产环境" }) });

    const view = await observerService.tree("acp-link");
    expect(view.names.organizationId["org-1"]).toBe("Acme 组织");
    expect(view.names.userId["user-1"]).toBe("张三");
    expect(view.names.agentConfigId["acfg-1"]).toBe("客服助手");
    expect(view.names.machineId.mach_1).toBe("边缘节点-01");
    // instance 名由 instance registry 回查 environmentId → environment 名 + 序号派生
    expect(view.names.instanceId["inst-1"]).toBe("生产环境 #2");
  });

  // names 缺失不占位：权威表未命中的 id 不出现在字典，前端回退显示原始 id
  test("names 字典：缺失 id 不占位", async () => {
    setObserverServiceDeps(
      makeFakeDeps({
        listExternalRelayEntries: () => [makeRelay()],
        getAgentConfigById: async () => ({ machineId: "mach_1" }),
        getInstanceSupplement: () => ({ environmentId: "env-missing", instanceNumber: 1 }),
      }),
    );
    stubEnvironmentRepo({ getById: async () => undefined });

    const view = await observerService.tree("acp-link");
    expect(view.names.organizationId).toEqual({});
    expect(view.names.userId).toEqual({});
    expect(view.names.agentConfigId).toEqual({});
    expect(view.names.instanceId).toEqual({});
    // 默认 fake deps 的 machine 名称解析返回空 Map
    expect(view.names.machineId).toEqual({});
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
      getRunningInstancesByEnvironment: () => [makeSpawnedInstance("inst-1")],
      connectAgentRelay: async () => createRelayHandle(),
      markRelayAttached: () => {},
      markRelayDetached: () => {},
      touchActivity: () => {},
    });
    const relayWs = createWs();
    const authCtx: AuthContext = { organizationId: "org-1", userId: "user-1", role: "owner" };
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
