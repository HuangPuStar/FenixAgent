import { persistYjsClearedSnapshotWithCas } from "@fenix/acp-server";
import { log, error as logError } from "@fenix/logger";
import type { Cluster, Redis } from "ioredis";
import * as Y from "yjs";
import { environmentRepo } from "../../../repositories/environment";
import { markInstanceRelayAttached, markInstanceRelayDetached } from "../../../services/acp-idle-monitor";
import { getRedisConnection } from "../../../services/cache";
import {
  clearSessionDocContent,
  clearSessionYDocContent,
  getChat,
  openChat,
  openSession,
  processACP,
  registerSession,
  setChatActiveSession,
  setChatAgentInfo,
  setChatAvailableCommands,
  setChatCapabilities,
  setChatConnectionStatus,
  setChatModelState,
  setChatModeState,
  setChatTokenUsage,
} from "../../../services/session-state-service";
import { resolveWorkspacePath } from "../../../services/workspace-resolver";
import { ConnectionRegistry } from "./connection-registry";
import { RelayEventHandler } from "./relay-event-handler";
import { SessionTransition } from "./session-transition";
import { WsLifecycle } from "./ws-lifecycle";
import { YjsBroadcaster } from "./yjs-broadcaster";

export { translateSimpleAction } from "./action-translator";
export {
  createDeterministicRcsSessionId,
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
  openSession,
  clearSessionDocContent,
  prepareClearSessionSnapshot: async (entry) => {
    const redis = getRedisConnection();
    if (!redis) return;
    const sessionDoc = await openSession(entry.userId, entry.agentId, entry.rcsSessionId);
    await persistClearedSessionSnapshot(redis, `yjs:session:${entry.rcsSessionId}`, sessionDoc.ydoc);
  },
  processACP,
  reportError: logError,
});
const relayEvents = new RelayEventHandler({
  registry,
  broadcaster,
  processACP,
  setChatConnectionStatus,
  setChatAvailableCommands,
  setChatTokenUsage,
  setChatCapabilities,
  setChatAgentInfo,
  setChatModelState,
  setChatModeState,
  registerSession,
  setChatActiveSession,
  getChat,
  openSession,
  registerYjsDocListener: broadcaster.registerYjsDocListener.bind(broadcaster),
  reportError: logError,
});
const lifecycle = new WsLifecycle({
  registry,
  broadcaster,
  relayEvents,
  transition: sessionTransition,
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
  openChat,
  openSession,
  setChatAgentInfo,
  setChatConnectionStatus,
  markRelayAttached: markInstanceRelayAttached,
  markRelayDetached: markInstanceRelayDetached,
  reportLog: log,
  reportError: logError,
  maxClients: () => parseInt(process.env.YJS_MAX_CLIENTS || "", 10) || 200,
});

/** 兼容现有路由的稳定 facade 导出。 */
export const handleYjsWsOpen = lifecycle.handleOpen.bind(lifecycle);
/** 兼容现有路由的稳定 facade 导出。 */
export const handleYjsWsMessage = lifecycle.handleMessage.bind(lifecycle);
/** 兼容现有路由的稳定 facade 导出。 */
export const handleYjsWsClose = lifecycle.handleClose.bind(lifecycle);
/** 兼容既有调用方的 WebSocket 发送 helper。 */
export const sendToYjsWs = broadcaster.sendToYjsWs.bind(broadcaster);
/** 兼容既有调用方的 Y.Doc 监听注册 helper。 */
export const registerYjsDocListener = broadcaster.registerYjsDocListener.bind(broadcaster);
/** 兼容既有调用方的 Y.Doc 监听注销 helper。 */
export const unregisterYjsDocListener = broadcaster.unregisterYjsDocListener.bind(broadcaster);
