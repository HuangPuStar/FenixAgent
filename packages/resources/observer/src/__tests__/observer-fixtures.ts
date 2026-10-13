// src/__tests__/observer-fixtures.ts
// Observer 测试夹具：为 observer-service 单测与路由单测提供各来源快照 / 权威表构造工厂与 fake deps。
//
// 来源与字段一一对应：AcpConnectionSnapshot / ExternalRelayConnectionSnapshot / ChatClientConnectionSnapshot /
// EnvironmentRecord / SpawnedInstance，改动来源字段时同步维护此处。除 workspace 包的公开入口外，
// 这里不导入任何宿主内部路径（`@server/*`）：夹具随包切片一起迁入，宿主副本因此成为死文件。
//
// 全部为 type-only 导入（除类型外无运行时依赖），不会把服务运行时图拖进测试模块。

import type { EnvironmentRecord, ExternalRelayConnectionSnapshot, SpawnedInstance } from "@fenix/agent-runtime/runtime";
import type {
  AcpConnectionSnapshot,
  ChatClientConnectionSnapshot,
  ObserverServiceDeps,
} from "../server/services/observer";

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
export function makeChat(overrides: Partial<ChatClientConnectionSnapshot> = {}): ChatClientConnectionSnapshot {
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

/**
 * 测试用的请求级宿主角色的**窄视图**：只含观察链路读取的三个字段。
 *
 * 权威定义在宿主 `apps/server/src/plugins/auth.ts`，包内不可导入。这里按消费面自持，是因为
 * agent-runtime 的 `handleExternalRelayOpen` 形参就是宿主的 `AuthContext`——结构化传参下，
 * 窄类型可赋给它，而宿主改字段名会在调用点编译失败（不会静默传错值）。
 * 不复刻 `memberships` 等本链路不读的字段：多写的字段会变成无人消费的夹具负担。
 */
export interface TestAuthContext {
  organizationId: string;
  userId: string;
  role: "owner" | "admin" | "member";
}

/** 默认 fake deps：所有来源为空、无 agentConfig、无默认 machine、名称解析为空。 */
export function makeFakeDeps(overrides: Partial<ObserverServiceDeps> = {}): Partial<ObserverServiceDeps> {
  return {
    listAcpWsConnections: () => [],
    listExternalRelayEntries: () => [],
    listChatClients: () => [],
    getAgentConfigById: async () => null,
    getDefaultMachineId: () => null,
    getInstanceName: async () => undefined,
    listOrganizationNamesByIds: async () => new Map(),
    listUserNamesByIds: async () => new Map(),
    listAgentConfigNamesByIds: async () => new Map(),
    listMachineNamesByIds: async () => new Map(),
    ...overrides,
  };
}

/**
 * 最小 WebSocket 连接桩（仅含 transport handler 用到的字段）。
 *
 * `WsConnection` 的权威定义在宿主 `apps/server/src/transport/ws-types.ts`（`send` / `close` /
 * `readonly readyState`，`bufferedAmount` 可选），包内不可导入。这里返回结构相同的对象字面量：
 * handler 的形参是结构化类型，宿主接口**新增**字段不受影响，**改名或改型**会在调用点编译失败，
 * 而不是让桩静默失效（测试里出现过「桩字段名过时、断言照过」的形态）。
 */
export function createWs(): { readyState: number; send: () => void; close: () => void } {
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
  };
}

/**
 * relay handle 桩（external-relay 集成用例用）——只实现用例读到的表面。
 *
 * 不导入 `@fenix/plugin-sdk` 的 `EngineRelayHandle`：观察包只在这个测试桩上用到它，为类型导入
 * 新增一条 workspace 依赖不值得（该包未在 `package.json` 声明，architecture 台账也会多一条边）。
 * 返回类型显式写出而不是靠推断：`state: "open"` 在推断下会加宽成 `string`，赋给注入点的
 * `EngineRelayState` 就成了错误。参数类型取 `unknown`（逆变方向可赋给更窄的形参），
 * 注入点若改签名会在调用点编译失败。
 */
export function createRelayHandle(): {
  readonly state: "open";
  send: (message: unknown) => void;
  onMessage: (listener: (message: unknown) => void) => () => void;
  close: () => void;
} {
  return { state: "open", send: () => {}, onMessage: () => () => {}, close: () => {} };
}
