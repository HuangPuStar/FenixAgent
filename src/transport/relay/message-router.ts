import { log } from "@fenix/logger";
import { getAcpEventBus } from "../event-bus";

/** Whether an outbound message should be intercepted (not forwarded to agent) */
export function shouldInterceptOutbound(message: Record<string, unknown>): boolean {
  return message.type === "keep_alive";
}

/** Whether an inbound message should be intercepted (not forwarded to frontend) */
export function shouldInterceptInbound(message: Record<string, unknown>): boolean {
  return message.type === "keep_alive";
}

/** Filter out "connect" messages from a flushed batch (relay handle auto-connects) */
export function filterConnectFromFlush(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  return messages.filter((msg) => msg.type !== "connect");
}

/** Publish relay messages to the ACP EventBus for SSE subscribers. */
export function publishToEventBus(agentId: string, message: Record<string, unknown>): void {
  const bus = getAcpEventBus(agentId);
  let eventType = typeof message.type === "string" ? message.type : "";
  if (!eventType) {
    const msg = message.message as Record<string, unknown> | undefined;
    if (msg && typeof msg.role === "string") {
      eventType = msg.role;
    }
  }
  if (!eventType) eventType = "acp_message";
  bus.publish({
    id: crypto.randomUUID(),
    sessionId: agentId,
    type: eventType,
    payload: message,
    direction: "inbound",
  });
}

/** Flush buffered outbound messages to a relay handle, filtering connect messages */
export function flushOutboundBuffer(buffer: Record<string, unknown>[], handle: { send: (msg: unknown) => void }): void {
  if (buffer.length === 0) return;
  const buffered = buffer.splice(0);
  log(`[ACP-Relay] Flushing ${buffered.length} buffered outbound messages`);
  const filtered = filterConnectFromFlush(buffered);
  for (const msg of filtered) {
    try {
      log("Relay → agent (buffer flush)", { msgType: msg.type, payload: JSON.stringify(msg).slice(0, 300) });
      handle.send(msg);
    } catch {
      break;
    }
  }
}
