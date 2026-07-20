import { ACPClient } from "./client";
import type { ACPSettings } from "./types";

/**
 * Create an ACPClient that connects to an agent through the socket.io /relay namespace.
 * Authentication is handled via cookies (better-auth session).
 */
export function createRelayClient(agentId: string, sessionId?: string): ACPClient {
  const activeOrgId = localStorage.getItem("active_org_id") ?? undefined;

  const settings: ACPSettings = {
    namespace: "/relay",
    agentId,
    sessionId: sessionId ?? undefined,
    activeOrganizationId: activeOrgId,
  };

  return new ACPClient(settings);
}
