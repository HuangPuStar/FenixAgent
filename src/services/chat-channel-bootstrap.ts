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

import type { ChatChannelDependencies } from "@fenix/chat-channel/server";
import {
  ChatChannelController,
  clearSessionDocContent,
  persistYjsClearedSnapshotWithCas,
} from "@fenix/chat-channel/server";
import { log, error as logError } from "@fenix/logger";
import type { Cluster, Redis } from "ioredis";
import * as Y from "yjs";
import { environmentRepo } from "../repositories/environment";
import { connectAgentRelay } from "../transport/agent-relay";
import { markInstanceRelayAttached, markInstanceRelayDetached, touchInstanceActivity } from "./acp-idle-monitor";
import { agentInstanceService } from "./agent-instance-service";
import { getRedisConnection } from "./cache";
import { classifyPermanentSpawnFailure, isMachineOfflineError } from "./chat-channel-error-classify";
import { docManager } from "./doc-manager-instance";
import { refreshInstanceEnvironment, terminateLocalDeadInstance } from "./orchestration-instance";
import { resolveWorkspacePath } from "./workspace-resolver";

type ChatChannelBootstrapDeps = {
  environmentRepo: typeof environmentRepo;
  resolveWorkspacePath: typeof resolveWorkspacePath;
  ensureRunning: (ownerUserId: string, environmentId: string, requestedInstanceUid?: string) => Promise<string>;
  connectAgentRelay: typeof connectAgentRelay;
  refreshInstanceEnvironment: typeof refreshInstanceEnvironment;
  markInstanceRelayAttached: typeof markInstanceRelayAttached;
  markInstanceRelayDetached: typeof markInstanceRelayDetached;
  touchInstanceActivity: typeof touchInstanceActivity;
  terminateLocalDeadInstance: typeof terminateLocalDeadInstance;
  getRedisConnection: typeof getRedisConnection;
  docManager: typeof docManager;
  isMachineOfflineError: typeof isMachineOfflineError;
  classifyPermanentSpawnFailure: typeof classifyPermanentSpawnFailure;
  log: typeof log;
  logError: typeof logError;
  maxClients: () => number;
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
  refreshInstanceEnvironment,
  markInstanceRelayAttached,
  markInstanceRelayDetached,
  touchInstanceActivity,
  terminateLocalDeadInstance,
  getRedisConnection,
  docManager,
  isMachineOfflineError,
  classifyPermanentSpawnFailure,
  log,
  logError,
  maxClients: () => parseInt(process.env.YJS_MAX_CLIENTS || "", 10) || 200,
};

let deps: ChatChannelBootstrapDeps = defaultDeps;

/** 测试用：覆盖桥接层依赖（部分覆盖，未覆盖字段回落默认实现）；传 null 恢复默认。 */
export function setChatChannelBootstrapDeps(overrides: Partial<ChatChannelBootstrapDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

/**
 * 以 CAS 方式把清空后的 Session Doc 快照持久化到 Redis（会话切换前的并发安全清理）。
 * Redis 冲突重试耗尽时抛错，由调用方保留诊断上下文（错误消息不包含会话内容）。
 */
export async function persistClearedSessionSnapshot(
  redis: Redis | Cluster,
  redisKey: string,
  ydoc: Y.Doc,
): Promise<void> {
  const persisted = await persistYjsClearedSnapshotWithCas(
    redis,
    redisKey,
    Y.encodeStateAsUpdate(ydoc),
    clearSessionDocContent,
  );
  if (!persisted) throw new Error("Redis snapshot conflict retries exhausted");
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
    refreshInstanceEnvironment: deps.refreshInstanceEnvironment,
    markRelayAttached: deps.markInstanceRelayAttached,
    markRelayDetached: deps.markInstanceRelayDetached,
    touchInstanceActivity: deps.touchInstanceActivity,
    terminateLocalDeadInstance: (instanceId) => {
      // orchestration-instance 的回收是异步的；relay 断链路径不等待回收完成，
      // 避免阻塞消息处理循环（回收失败由该函数内部日志保留诊断上下文）。
      void deps.terminateLocalDeadInstance(instanceId);
    },
    prepareClearSessionSnapshot: async (connection) => {
      const redis = deps.getRedisConnection();
      if (!redis) return;
      const sessionDoc = await deps.docManager.openSession(
        connection.userId,
        connection.agentId,
        connection.rcsSessionId,
      );
      await persistClearedSessionSnapshot(redis, `yjs:session:${connection.rcsSessionId}`, sessionDoc.ydoc);
    },
    isMachineOffline: deps.isMachineOfflineError,
    classifyPermanentSpawnFailure: deps.classifyPermanentSpawnFailure,
    maxClients: deps.maxClients,
    log: deps.log,
    reportError: deps.logError,
  };
}

let controller: ChatChannelController | null = null;

/** 获取 Chat 域控制器单例（YJS WS 入口与连接注册表的统一访问点）。 */
export function getChatChannelController(): ChatChannelController {
  if (!controller) {
    controller = new ChatChannelController(buildChatChannelDependencies());
  }
  return controller;
}

/** 重置控制器单例缓存（仅用于测试；测试注入依赖后必须重置才能生效）。 */
export function resetChatChannelBootstrap(): void {
  controller = null;
}
