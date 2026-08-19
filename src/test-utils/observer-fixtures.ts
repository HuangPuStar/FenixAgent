// src/test-utils/observer-fixtures.ts
// Observer Service 测试夹具：为 observer-service 单测与 API 单测提供
// 各来源快照/权威表构造工厂与 fake deps。全部为 type-only 导入，
// 不会把服务运行时图拖进测试模块（CLAUDE.md 测试模块图要求）。
//
// 与真实来源字段一一对应：AcpConnectionSnapshot / ExternalRelayConnectionSnapshot /
// ChatClientSnapshot / EnvironmentRecord，改动来源字段时同步维护此处。

import type { EngineRelayHandle } from "@fenix/plugin-sdk";
import type { EnvironmentRecord } from "../repositories";
import type { SpawnedInstance } from "../services/instance";
import type { ChatClientSnapshot, ObserverServiceDeps } from "../services/observer";
import type { ExternalRelayConnectionSnapshot } from "../transport/relay/external-relay";
import type { WsConnection } from "../transport/ws-types";
import type { AcpConnectionSnapshot } from "../types/store";

/** environment 权威表记录构造器（默认 org-1/user-1/acfg-1）。 */
export function makeEnv(overrides: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  return {
    id: "env-1",
    name: "env-1",
    description: null,
    workspacePath: "/tmp",
    agentConfigId: "acfg-1",
    secret: "sec-1",
    machineName: null,
    directory: null,
    branch: null,
    gitRepoUrl: null,
    maxSessions: 1,
    workerType: "opencode",
    capabilities: null,
    status: "active",
    username: null,
    userId: "user-1",
    organizationId: "org-1",
    autoStart: false,
    lastPollAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** acp-ws machine 连接快照构造器（userId 为路由层哨兵 "__machine__"）。 */
export function makeAcpWsMachine(overrides: Partial<AcpConnectionSnapshot> = {}): AcpConnectionSnapshot {
  return {
    wsId: "ws_m1",
    userId: "__machine__",
    agentId: null,
    boundEnvId: null,
    machineId: "mach_x",
    isMachine: true,
    openTime: 1000,
    capabilities: { hello: true },
    ...overrides,
  };
}

/** acp-ws 本地链接快照构造器（boundEnvId 指向 env-1，非实例）。 */
export function makeAcpWsLocal(overrides: Partial<AcpConnectionSnapshot> = {}): AcpConnectionSnapshot {
  return {
    wsId: "ws_l1",
    userId: "user-1",
    agentId: null,
    boundEnvId: "env-1",
    machineId: null,
    isMachine: false,
    openTime: 2000,
    capabilities: null,
    ...overrides,
  };
}

/** external-relay 连接快照构造器（org-1/user-1/instance inst-1）。 */
export function makeRelay(overrides: Partial<ExternalRelayConnectionSnapshot> = {}): ExternalRelayConnectionSnapshot {
  return {
    relayWsId: "ext_relay_1",
    agentId: "env-1",
    instanceId: "inst-1",
    organizationId: "org-1",
    userId: "user-1",
    openTime: 3000,
    ...overrides,
  };
}

/** chat-relay 客户端快照构造器（rcs_1/ses_1）。 */
export function makeChat(overrides: Partial<ChatClientSnapshot> = {}): ChatClientSnapshot {
  return {
    wsId: "yjs_1",
    userId: "user-1",
    agentId: "env-1",
    instanceId: "inst-1",
    rcsSessionId: "rcs_1",
    acpSessionId: "ses_1",
    openTime: 4000,
    ...overrides,
  };
}

/** 默认 fake deps：所有来源为空、无 agentConfig、无默认 machine、名称解析为空。 */
export function makeFakeDeps(overrides: Partial<ObserverServiceDeps> = {}): Partial<ObserverServiceDeps> {
  return {
    listAcpWsConnections: () => [],
    listExternalRelayEntries: () => [],
    listChatClients: () => [],
    getAgentConfigById: async () => null,
    getDefaultMachineId: () => null,
    getInstanceSupplement: () => undefined,
    listOrganizationNamesByIds: async () => new Map(),
    listUserNamesByIds: async () => new Map(),
    listAgentConfigNamesByIds: async () => new Map(),
    listMachineNamesByIds: async () => new Map(),
    ...overrides,
  };
}

/** 最小 WsConnection 桩（仅含 handler 用到的字段）。 */
export function createWs(): WsConnection {
  return { readyState: 1, send: () => {}, close: () => {} };
}

/** SpawnedInstance 构造器（external-relay 集成用例用）。 */
export function makeSpawnedInstance(id: string): SpawnedInstance {
  return {
    id,
    userId: "user-1",
    port: 0,
    pid: null,
    status: "running",
    command: "",
    error: null,
    apiKey: "api-key",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    instanceNumber: 1,
  };
}

/** EngineRelayHandle 桩（external-relay 集成用例用）。 */
export function createRelayHandle(): EngineRelayHandle {
  return { state: "open", send: () => {}, onMessage: () => () => {}, close: () => {} };
}
