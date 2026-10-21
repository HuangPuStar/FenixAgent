import type * as Y from "yjs";
import type { DocManager } from "../state/doc-manager";
import type { SharedRelay } from "./connection-types";
import type { RelayEventHandler } from "./relay-event-handler";

/** Seed the shared consumer from the server projection before a buffered notification can arrive. */
export async function attachGatewayRelay(
  shared: SharedRelay,
  docManager: DocManager,
  relayEvents: RelayEventHandler,
): Promise<void> {
  const session = await docManager.openSession(shared.userId, shared.agentId, shared.rcsSessionId);
  const info = session.ydoc.getMap("root").get("session") as Y.Map<unknown> | undefined;
  const sessionId = info?.get("sessionId");
  shared.handle.setSessionSubscription?.(typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null);
  shared.unsubscribe = shared.handle.onMessage?.(relayEvents.createMessageHandler(shared)) ?? null;
}
