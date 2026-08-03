import { clearSessionYDocContent, persistYjsClearedSnapshotWithCas } from "@fenix/acp-server";
import { log, error as logError } from "@fenix/logger";
import type { Cluster, Redis } from "ioredis";
import * as Y from "yjs";
import { environmentRepo } from "../../../repositories/environment";
import { markInstanceRelayAttached, markInstanceRelayDetached } from "../../../services/acp-idle-monitor";
import { getRedisConnection } from "../../../services/cache";
import { docManager } from "../../../services/doc-manager-instance";
import { parseInstanceSessionId } from "../../../services/instance-session";
import { resolveWorkspacePath } from "../../../services/workspace-resolver";
import { ConnectionRegistry } from "./connection-registry";
import { RelayEventHandler } from "./relay-event-handler";
import { SessionTransition } from "./session-transition";
import { WsLifecycle } from "./ws-lifecycle";
import { YjsBroadcaster } from "./yjs-broadcaster";

export { createDeterministicRcsSessionId, translateSimpleAction } from "@fenix/acp-server";
export {
  type ForwardYjsActionDependencies,
  flushPendingYjsActions,
  forwardYjsAction,
} from "./ws-lifecycle";

export async function persistClearedSessionSnapshot(
  redis: Redis | Cluster,
  redisKey: string,
  ydoc: Y.Doc,
): Promise<void> {
  const persisted = await persistYjsClearedSnapshotWithCas(
    redis,
    redisKey,
    Y.encodeStateAsUpdate(ydoc),
    clearSessionYDocContent,
  );
  if (!persisted) throw new Error("Redis snapshot conflict retries exhausted");
}

const registry = new ConnectionRegistry();
const broadcaster = new YjsBroadcaster(registry);
const sessionTransition = new SessionTransition({
  docManager,
  prepareClearSessionSnapshot: async (entry) => {
    const redis = getRedisConnection();
    if (!redis) return;
    const sessionDoc = await docManager.openSession(entry.userId, entry.agentId, entry.rcsSessionId);
    await persistClearedSessionSnapshot(redis, `yjs:session:${entry.rcsSessionId}`, sessionDoc.ydoc);
  },
  syncSessionId: (entry, newSessionId) => {
    // 会话切换后同步 ACP session ID 到同一 RCS 会话的所有客户端，
    // 使同一会话的多标签页保持一致，且不污染其他 RCS 会话。
    registry.forEachByRcsSession(entry.rcsSessionId, (other) => {
      other.acpSessionId = newSessionId;
      other.sessionLoaded = true;
    });
  },
  reportError: logError,
});
const relayEvents = new RelayEventHandler({
  registry,
  broadcaster,
  docManager,
  registerYjsDocListener: broadcaster.registerYjsDocListener.bind(broadcaster),
  reportError: logError,
});
const lifecycle = new WsLifecycle({
  registry,
  broadcaster,
  relayEvents,
  transition: sessionTransition,
  docManager,
  getEnvironment: environmentRepo.getById.bind(environmentRepo),
  // 路由已使用 authContext 验证组织成员资格；这里仅作为纵深防御，不能把组织环境误当成个人环境。
  // 组织环境由 route 的 authContext 决定访问权；无 owner 的历史/桥接环境可继续访问。
  authorizeEnvironment: (userId, environment) =>
    environment.organizationId !== null && environment.organizationId !== undefined
      ? true
      : !environment.userId || environment.userId === userId,
  resolveWorkspacePath,
  // I4 调用方迁移说明：YJS 前端 Chat 走 Chat 域重构（ChatChannelController），
  // 不在编排域重构 I4 范围内（I4 文档：如已在 I3 范围外则保留现有逻辑），
  // 继续复用旧 ensureRunning 的实例复用语义；Phase D 随 Chat 域重构一并迁移。
  ensureRunning: async (userId, agentId, mode, instanceNumber) =>
    (await import("../../../services/instance")).ensureRunning(userId, agentId, mode, instanceNumber),
  connectAgentRelay: async (instanceId, rcsSessionId) =>
    (await import("../../agent-relay")).connectAgentRelay(instanceId, rcsSessionId),
  markRelayAttached: markInstanceRelayAttached,
  markRelayDetached: markInstanceRelayDetached,
  reportLog: log,
  reportError: logError,
  maxClients: () => parseInt(process.env.YJS_MAX_CLIENTS || "", 10) || 200,
  resolveInstanceNumberFromSession: async (sessionId: string) => {
    // 从确定性会话 ID（ses_inst_{environmentId}_{instanceNumber}）解析实例编号；
    // agent_session 表已废弃，不再查 DB 标题。
    const parsed = parseInstanceSessionId(sessionId);
    if (!parsed) throw new Error(`Invalid instance session id: ${sessionId}`);
    return parsed.instanceNumber;
  },
});

export { lifecycle, registry };
