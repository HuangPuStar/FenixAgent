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
    // 从 DB session 标题 "Instance N" 解析实例编号，用于多实例 YJS doc 隔离。
    // 标题不匹配（单实例普通会话/历史会话）时返回 undefined（默认实例），不得
    // 拒绝连接：URL 携带 sessionId 是前端路由的常规状态（侧边栏选择实例/会话后
    // 刷新），单实例场景下会话标题是普通对话标题，抛错会让 WS 连接直接失败
    // （close 4004），用户刷新后发送的消息被前端静默丢弃、服务端无感知。
    // 多实例下不匹配的会话仅出现在异常引用，降级到默认实例可继续使用。
    const { _sessionRepo } = await import("../../../services/session");
    const session = await _sessionRepo.getById(sessionId);
    if (!session?.title) return;
    const match = session.title.match(/^Instance (\d+)$/);
    if (!match) return;
    return parseInt(match[1], 10);
  },
});

export { lifecycle, registry };
