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

import type { ChatChannelDependencies } from "@fenix/chat-channel";
import { ChatChannelController, clearSessionDocContent, persistYjsClearedSnapshotWithCas } from "@fenix/chat-channel";
import { log, error as logError } from "@fenix/logger";
import type { Cluster, Redis } from "ioredis";
import * as Y from "yjs";
import { environmentRepo } from "../repositories/environment";
import { connectAgentRelay } from "../transport/agent-relay";
import { markInstanceRelayAttached, markInstanceRelayDetached, touchInstanceActivity } from "./acp-idle-monitor";
import { getRedisConnection } from "./cache";
import { classifyPermanentSpawnFailure, isMachineOfflineError } from "./chat-channel-error-classify";
import { docManager } from "./doc-manager-instance";
import { ensureRunning } from "./instance";
import { parseInstanceSessionId } from "./instance-session";
import { terminateLocalDeadInstance } from "./orchestration-instance";
import { resolveWorkspacePath } from "./workspace-resolver";

type ChatChannelBootstrapDeps = {
  environmentRepo: typeof environmentRepo;
  resolveWorkspacePath: typeof resolveWorkspacePath;
  ensureRunning: typeof ensureRunning;
  connectAgentRelay: typeof connectAgentRelay;
  markInstanceRelayAttached: typeof markInstanceRelayAttached;
  markInstanceRelayDetached: typeof markInstanceRelayDetached;
  touchInstanceActivity: typeof touchInstanceActivity;
  terminateLocalDeadInstance: typeof terminateLocalDeadInstance;
  getRedisConnection: typeof getRedisConnection;
  docManager: typeof docManager;
  parseInstanceSessionId: typeof parseInstanceSessionId;
  isMachineOfflineError: typeof isMachineOfflineError;
  classifyPermanentSpawnFailure: typeof classifyPermanentSpawnFailure;
  log: typeof log;
  logError: typeof logError;
  maxClients: () => number;
};

const defaultDeps: ChatChannelBootstrapDeps = {
  environmentRepo,
  resolveWorkspacePath,
  ensureRunning,
  connectAgentRelay,
  markInstanceRelayAttached,
  markInstanceRelayDetached,
  touchInstanceActivity,
  terminateLocalDeadInstance,
  getRedisConnection,
  docManager,
  parseInstanceSessionId,
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
    // 路由已用 authContext 验证组织成员资格；这里仅作为纵深防御，不能把组织环境
    // 误当成个人环境（无 owner 的历史/桥接环境可继续访问）。
    authorizeEnvironment: (userId, environment) =>
      environment.organizationId !== null && environment.organizationId !== undefined
        ? true
        : !environment.userId || environment.userId === userId,
    getEnvironment: deps.environmentRepo.getById.bind(deps.environmentRepo),
    resolveWorkspacePath: deps.resolveWorkspacePath,
    // I4 说明：YJS 前端 Chat 走 Chat 域重构（ChatChannelController），继续复用
    // ensureRunning 的实例复用语义（先复用运行实例、仅新建时检查并发配额，场景 K）；
    // spawn 分支内部委托 spawnInstanceViaController 创建独立实例并负责销毁。
    ensureRunning: (userId, agentId, mode, instanceNumber) => deps.ensureRunning(userId, agentId, mode, instanceNumber),
    connectAgentRelay: deps.connectAgentRelay,
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
    resolveInstanceNumberFromSession: async (sessionId) => {
      // 从确定性会话 ID（ses_inst_{environmentId}_{instanceNumber}）解析实例编号；
      // agent_session 表已废弃，不再查 DB 标题。
      // 无法解析（历史 session_* 书签、ACP ses_* 混入、格式非法）返回 null 而非抛错：
      // 这是可预期的前端输入形态，由 gateway 按默认实例降级连接；
      // message 不得包含 sessionId——其可含 envId 等标识，进入日志即构成敏感信息泄漏
      const parsed = deps.parseInstanceSessionId(sessionId);
      return parsed?.instanceNumber ?? null;
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
