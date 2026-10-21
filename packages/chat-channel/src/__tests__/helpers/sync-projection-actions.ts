import { randomUUID } from "node:crypto";
import type { MockWs } from "../../channel/connection-test-helpers";

/** 使用真实 attach 握手签发的代次，避免同步投影回归绕过网络命令准入。 */
export function encodeClientAction(ws: MockWs, action: Record<string, unknown>): string {
  const handshake = ws.messages
    .filter((message): message is string => typeof message === "string")
    .map((message) => JSON.parse(message) as { type?: unknown; epoch?: unknown })
    .findLast((message) => message.type === "yjs:command-epoch");
  if (typeof handshake?.epoch !== "string" || handshake.epoch.length === 0) {
    throw new Error("expected command epoch handshake before client action");
  }
  return JSON.stringify({ ...action, commandId: `${handshake.epoch}.${randomUUID()}` });
}
