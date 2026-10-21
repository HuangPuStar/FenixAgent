import type { SessionConnection } from "./session-connection";
import type { Command } from "./types";

/** 浏览器字段只用于动作前置条件；频道身份始终由已认证连接注入。 */
export function normalizeSessionCommand(connection: SessionConnection, rawAction: Record<string, unknown>): Command {
  const { action, commandId, expectedProjectionVersion, protocolVersion, client, ...payload } = rawAction;
  void protocolVersion;
  void client;
  return {
    rcsSessionId: connection.rcsSessionId,
    commandId: typeof commandId === "string" ? commandId : "",
    type: typeof action === "string" ? action : "",
    sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "",
    payload,
    ...(typeof expectedProjectionVersion === "number" ? { expectedProjectionVersion } : {}),
  };
}
