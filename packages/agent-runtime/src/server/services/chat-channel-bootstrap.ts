// src/services/chat-channel-bootstrap.ts
// Chat 域宿主桥接层（C7）：包内 ChatChannelDependencies 的宿主实现装配与单例缓存。
//
// 复制编排域桥接模式（orchestration-bootstrap.ts / orchestration-instance.ts）：
// - _deps 惰性引用宿主模块单例，setChatChannelBootstrapDeps(null) 供测试注入 fake
//   （测试禁止直接 mock.module，CLAUDE.md 质量红线）；
// - getChatChannelController 惰性构造并缓存单例，resetChatChannelBootstrap 仅用于测试。
//
// 单例缓存是必要的：SessionChannel 构造时会向 DocManager 注册权限请求回调（单槽位
// 装配点），重复构造会覆盖前者导致权限超时迁移失效，因此一个进程内至多一个控制器。

import type {
  ChatChannelDependencies,
  ChatSyncProtocolConfig,
  SessionTitleStore,
  SnapshotPersistConfigSource,
} from "@fenix/chat-channel/server";
import {
  ChatChannelController,
  classifyPermanentSpawnFailure,
  createRedisSessionTitleStore,
  docManager,
  isMachineOfflineError,
} from "@fenix/chat-channel/server";
import { log, error as logError } from "@fenix/logger";
import { getRedisConnection } from "@fenix/platform-sdk/server";
import type { Cluster, Redis } from "ioredis";
import {
  markInstanceRelayAttached,
  markInstanceRelayDetached,
  touchInstanceActivity,
} from "../../services/acp-idle-monitor";
import { refreshInstanceEnvironment } from "../../services/orchestration-instance";
import { getAgentRuntimeConfig } from "../config";
import { environmentRepo } from "../repositories/environment";
import { createFileSessionTitleStore } from "../repositories/session-title-store";
import { connectAgentRelay, getAgentRuntimeIdentity } from "../transport/agent-relay";
import { bindRelayLifecyclePort } from "../transport/relay/lifecycle-port";
import { agentInstanceService } from "./agent-instance-service";
import { resolveSessionMcpServers } from "./session-mcp-provider";
import { resolveWorkspacePath } from "./workspace-resolver";

type ChatChannelBootstrapDeps = {
  environmentRepo: typeof environmentRepo;
  resolveWorkspacePath: typeof resolveWorkspacePath;
  ensureRunning: (ownerUserId: string, environmentId: string, requestedInstanceUid?: string) => Promise<string>;
  connectAgentRelay: typeof connectAgentRelay;
  getRuntimeIdentity: typeof getAgentRuntimeIdentity;
  refreshInstanceEnvironment: typeof refreshInstanceEnvironment;
  markInstanceRelayAttached: typeof markInstanceRelayAttached;
  markInstanceRelayDetached: typeof markInstanceRelayDetached;
  touchInstanceActivity: typeof touchInstanceActivity;
  docManager: typeof docManager;
  isMachineOfflineError: typeof isMachineOfflineError;
  classifyPermanentSpawnFailure: typeof classifyPermanentSpawnFailure;
  log: typeof log;
  logError: typeof logError;
  maxClients: () => number;
  chatSyncProtocol: () => ChatSyncProtocolConfig;
  snapshotPersist: SnapshotPersistConfigSource;
  sessionTitleStore: () => SessionTitleStore;
};

const defaultDeps: ChatChannelBootstrapDeps = {
  environmentRepo,
  resolveWorkspacePath,
  ensureRunning: async (ownerUserId, environmentId, requestedInstanceUid) => {
    const instance = await agentInstanceService.resolveInstanceForOperation({
      environmentId,
      ownerUserId,
      requestedInstanceUid,
      automaticSelection: "chat",
    });
    await agentInstanceService.ensureInstanceRuntime(instance);
    return instance.id;
  },
  connectAgentRelay,
  getRuntimeIdentity: getAgentRuntimeIdentity,
  refreshInstanceEnvironment,
  markInstanceRelayAttached,
  markInstanceRelayDetached,
  touchInstanceActivity,
  docManager,
  isMachineOfflineError,
  classifyPermanentSpawnFailure,
  log,
  logError,
  // 连接上限取模块配置（1.7 C1）：原先直读 `process.env.YJS_MAX_CLIENTS` 并 `|| 200` 兜底——非法值静默回落
  // 到 200、负值被原样接受。schema 已随 `envDefinitions` 迁到本模块 manifest，启动期校验保证此处必是正整数。
  // 闭包保持惰性：`defaultDeps` 是模块级常量，装配期求值会撞上「基础设施尚未初始化」。
  maxClients: () => getAgentRuntimeConfig().yjsMaxClients,
  // 新同步协议开关与宽限期：与其余旋钮同一数据流（模块配置注入），包内不读 process.env。
  // 宿主 env 投影未提供时模块 schema 的默认值保持启用；非新协议帧仍走旧 Yjs 路径。
  chatSyncProtocol: () => {
    const config = getAgentRuntimeConfig();
    return {
      enabled: config.chatSyncProtocolEnabled,
      sealGraceMs: config.chatSyncSealGraceMs,
      retireGraceMs: config.chatSyncRetireGraceMs,
    };
  },
  // 快照节流 / TTL 参数同样取模块配置（F1）：三项原先由宿主 `env.ts` 声明、由 chat-channel 持久层
  // 直读 `process.env` 并自带一份默认值，绕过启动期校验。声明已迁入本模块 manifest，值经
  // `ChatChannelDependencies.snapshotPersist` 装入 DocManager；包内直读与包内默认值同批删除。
  snapshotPersist: () => {
    const config = getAgentRuntimeConfig();
    return {
      intervalMs: config.yjsSnapshotIntervalMs,
      idleMs: config.yjsSnapshotIdleMs,
      ttlSeconds: config.yjsSnapshotTtlSeconds,
    };
  },
  sessionTitleStore: () => {
    const redis = getRedisConnection<Redis | Cluster>();
    return redis
      ? createRedisSessionTitleStore(() => getRedisConnection<Redis | Cluster>())
      : createFileSessionTitleStore(() => getAgentRuntimeConfig().workspaceRoot);
  },
};

let deps: ChatChannelBootstrapDeps = defaultDeps;

/** 测试用：覆盖桥接层依赖（部分覆盖，未覆盖字段回落默认实现）；传 null 恢复默认。 */
export function setChatChannelBootstrapDeps(overrides: Partial<ChatChannelBootstrapDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

function buildChatChannelDependencies(): ChatChannelDependencies {
  return {
    docManager: deps.docManager,
    // 路由和宿主边界均要求当前用户是 Environment owner，避免组织成员间共享 runtime/workspace。
    authorizeEnvironment: (userId, environment) => Boolean(environment.userId) && environment.userId === userId,
    getEnvironment: deps.environmentRepo.getById.bind(deps.environmentRepo),
    resolveWorkspacePath: deps.resolveWorkspacePath,
    ensureRunning: deps.ensureRunning,
    connectAgentRelay: deps.connectAgentRelay,
    getRuntimeIdentity: deps.getRuntimeIdentity,
    refreshInstanceEnvironment: deps.refreshInstanceEnvironment,
    markRelayAttached: deps.markInstanceRelayAttached,
    markRelayDetached: deps.markInstanceRelayDetached,
    touchInstanceActivity: deps.touchInstanceActivity,
    isMachineOffline: deps.isMachineOfflineError,
    classifyPermanentSpawnFailure: deps.classifyPermanentSpawnFailure,
    maxClients: deps.maxClients,
    chatSyncProtocol: deps.chatSyncProtocol(),
    snapshotPersist: deps.snapshotPersist,
    // 通道 B：会话级 MCP。组织上下文来自环境（Chat 的 `agentId` 就是 environment.id）；
    // 查不到环境时仍交给提供方判断（它会因缺组织而跳过），不在这里抛错。
    sessionMcpServers: async (connection) => {
      const environment = await deps.environmentRepo.getById(connection.agentId);
      return resolveSessionMcpServers({
        userId: connection.userId,
        agentId: connection.agentId,
        instanceId: connection.instanceId,
        rcsSessionId: connection.rcsSessionId,
        ...(environment?.organizationId ? { organizationId: environment.organizationId } : {}),
      });
    },
    log: deps.log,
    reportError: deps.logError,
  };
}

let controller: ChatChannelController | null = null;

/** 获取 Chat 域控制器单例（YJS WS 入口与连接注册表的统一访问点）。 */
export function getChatChannelController(): ChatChannelController {
  if (!controller) {
    deps.docManager.setSessionTitleStore(deps.sessionTitleStore());
    controller = new ChatChannelController(buildChatChannelDependencies());
  }
  return controller;
}

bindRelayLifecyclePort({
  closeClientsByInstance: (instanceId, code, reason) =>
    getChatChannelController().registry.closeClientsByInstance(instanceId, code, reason),
  reclaimInstanceRealtimeResources: (instanceId) =>
    getChatChannelController().relayEvents.reclaimInstanceRealtimeResources(instanceId),
  closeAllClients: (code, reason) => getChatChannelController().registry.closeAll(code, reason),
});

/** 重置控制器单例缓存（仅用于测试；测试注入依赖后必须重置才能生效）。 */
export function resetChatChannelBootstrap(): void {
  controller = null;
}
