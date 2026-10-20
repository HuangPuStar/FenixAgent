import { AppError } from "@fenix/platform-sdk";

/** Ownership of one ACP session; only its confirmed turn or runtime stop may release it. */
export interface AgentSessionTurnLease {
  release(): void;
}
const activeSessions = new Map<string, Map<string, symbol>>();

/** ACP cancellation names a session, so overlapping consumers of that session are rejected. */
export function acquireAgentSessionTurn(instanceId: string, sessionId: string): AgentSessionTurnLease {
  let sessions = activeSessions.get(instanceId);
  if (sessions?.has(sessionId))
    throw new AppError("Agent session already has an active turn", "AGENT_SESSION_BUSY", 409);
  if (!sessions) {
    sessions = new Map();
    activeSessions.set(instanceId, sessions);
  }
  const token = Symbol(sessionId);
  sessions.set(sessionId, token);
  return {
    release() {
      const current = activeSessions.get(instanceId);
      if (current?.get(sessionId) !== token) return;
      current.delete(sessionId);
      if (current.size === 0) activeSessions.delete(instanceId);
    },
  };
}

/** Coordinator calls this only after confirming the current runtime has stopped. */
export function releaseAgentSessionTurns(instanceId: string): void {
  activeSessions.delete(instanceId);
}
