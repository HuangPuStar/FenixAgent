import { createLogger } from "@fenix/logger";
import type { DocManager } from "../state/doc-manager";
import type { ConnectionRegistry } from "./connection-registry";
import type { ClientConnection, WsConnection } from "./connection-types";

const logger = createLogger("sync-close");

export interface SyncCloseContext {
  readonly wsId: string;
  readonly entryExists: boolean;
  readonly pendingTextFrames: number;
  readonly pendingBinaryFrames: number;
  readonly organizationId: string | null;
  readonly rcsSessionId: string | null;
  readonly acpSessionId: string | null;
  readonly relayReady: boolean | null;
  readonly sessionLoaded: boolean | null;
  readonly activeTurnId: string | null;
}

const contexts = new WeakMap<object, SyncCloseContext>();

/** 在每次入站帧处理前刷新上下文；关闭发生在任意 async 分支时仍能取到最近事实。 */
export function setSyncCloseContext(ws: WsConnection, context: SyncCloseContext): void {
  contexts.set(ws, context);
}

/** Gateway 入站帧边界刷新上下文：entry 是否存在、pending 帧数与认证后的 scope 标识。 */
export function setSyncCloseContextForConnection(
  registry: Pick<ConnectionRegistry, "pendingTextCount" | "pendingBinaryCount">,
  ws: WsConnection,
  wsId: string,
  entry: ClientConnection | undefined,
  docManager?: Pick<DocManager, "getSessionYdoc">,
): void {
  const sessionDoc = entry ? docManager?.getSessionYdoc(entry.rcsSessionId) : undefined;
  const session = sessionDoc?.getMap("root").get("session") as { get: (key: string) => unknown } | undefined;
  setSyncCloseContext(ws, {
    wsId,
    entryExists: entry !== undefined,
    pendingTextFrames: registry.pendingTextCount(wsId),
    pendingBinaryFrames: registry.pendingBinaryCount(wsId),
    organizationId: entry?.organizationId ?? null,
    rcsSessionId: entry?.rcsSessionId ?? null,
    acpSessionId: entry?.acpSessionId ?? null,
    relayReady: entry?.relayReady ?? null,
    sessionLoaded: entry?.sessionLoaded ?? null,
    activeTurnId: (session?.get("activeTurnId") as string | undefined) ?? null,
  });
}

/** 关闭诊断与主日志共享脱敏、追踪关联和唯一采集路径。 */
export function logSyncClose(
  ws: WsConnection,
  input: { readonly code: number; readonly reason: string; readonly source: "gateway-route" | "sync-provider" },
): void {
  const context = contexts.get(ws);
  logger.info("同步连接关闭", {
    at: new Date().toISOString(),
    code: input.code,
    reason: input.reason.slice(0, 500),
    source: input.source,
    wsId: context?.wsId ?? null,
    entryExists: context?.entryExists ?? null,
    pendingTextFrames: context?.pendingTextFrames ?? null,
    pendingBinaryFrames: context?.pendingBinaryFrames ?? null,
    organizationId: context?.organizationId ?? null,
    rcsSessionId: context?.rcsSessionId ?? null,
    acpSessionId: context?.acpSessionId ?? null,
    relayReady: context?.relayReady ?? null,
    sessionLoaded: context?.sessionLoaded ?? null,
    activeTurnId: context?.activeTurnId ?? null,
  });
}
