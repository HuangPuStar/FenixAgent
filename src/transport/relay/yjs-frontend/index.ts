import { clearSessionYDocContent, persistYjsClearedSnapshotWithCas } from "@fenix/acp-server";
import { log, error as logError } from "@fenix/logger";
import type { Cluster, Redis } from "ioredis";
import * as Y from "yjs";
import { environmentRepo } from "../../../repositories/environment";
import { markInstanceRelayAttached, markInstanceRelayDetached } from "../../../services/acp-idle-monitor";
import { getRedisConnection } from "../../../services/cache";
import { docManager } from "../../../services/doc-manager-instance";
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
    // 会话切换后同步 acpSessionId 到同一 instance+user 的所有客户端，
    // 防止多客户端场景下一个客户端切会话后其他客户端因 acpSessionId 不匹配而看到空白
    registry.forEachByInstanceUser(entry.agentId, entry.instanceId, entry.userId, (other) => {
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
  ensureRunning: async (userId, agentId, mode) =>
    (await import("../../../services/instance")).ensureRunning(userId, agentId, mode),
  connectAgentRelay: async (instanceId, rcsSessionId) =>
    (await import("../../agent-relay")).connectAgentRelay(instanceId, rcsSessionId),
  markRelayAttached: markInstanceRelayAttached,
  markRelayDetached: markInstanceRelayDetached,
  reportLog: log,
  reportError: logError,
  maxClients: () => parseInt(process.env.YJS_MAX_CLIENTS || "", 10) || 200,
});

export { lifecycle };
