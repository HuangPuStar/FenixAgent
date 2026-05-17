import Elysia from "elysia";
import { validateApiKeyAndGetUser } from "../../auth/api-key-service";
import { auth } from "../../auth/better-auth";
import {
  handleAcpWsOpen,
  handleAcpWsMessage,
  handleAcpWsClose,
} from "../../transport/acp-ws-handler";
import {
  handleRelayOpen,
  handleRelayMessage,
  handleRelayClose,
} from "../../transport/acp-relay-handler";
import { environmentRepo } from "../../repositories";
import { getEnvironmentBySecret } from "../../services/environment";
import { log, error as logError } from "../../logger";
import { authGuardPlugin, lookupUserById } from "../../plugins/auth";
import type { WsConnection } from "../../transport/ws-types";
import { v4 as uuid } from "uuid";

/** Maximum WebSocket message size: 10 MB */
const MAX_WS_MESSAGE_SIZE = 10 * 1024 * 1024;

/** Adapt Elysia WS to WsConnection interface */
function adaptWs(ws: any): WsConnection {
  return {
    send: (data: string) => ws.send(data),
    close: (code?: number, reason?: string) => ws.close(code, reason),
    get readyState() { return ws.readyState; },
  };
}

/** Response shape for an ACP agent */
function toAcpAgentResponse(env: NonNullable<Awaited<ReturnType<typeof environmentRepo.getById>>>) {
  return {
    id: env.id,
    agent_name: env.machineName,
    status: env.status === "active" ? "online" : "offline",
    max_sessions: env.maxSessions,
    last_seen_at: env.lastPollAt ? env.lastPollAt.getTime() / 1000 : null,
    created_at: env.createdAt.getTime() / 1000,
  };
}

/** Resolve userId from token (two-level auth) */
async function resolveTokenAuth(token: string | undefined): Promise<{ userId: string; envId?: string } | null> {
  if (!token) return null;

  // 0. Environment secret match
  const envRecord = await getEnvironmentBySecret(token);
  if (envRecord) {
    if (envRecord.userId) {
      return { userId: envRecord.userId, envId: envRecord.id };
    }
  }

  // 1. Per-user API Key
  const keyInfo = await validateApiKeyAndGetUser(token);
  if (keyInfo) {
    const userRow = await lookupUserById(keyInfo.userId);
    if (userRow) {
      return { userId: userRow.id };
    }
  }

  return null;
}

const app = new Elysia({ name: "acp", prefix: "/acp" })
  .use(authGuardPlugin)

  /** GET /acp/agents — List current user's ACP agents */
  .get("/agents", async ({ store }) => {
    const currentUser = store.user!;
    const agents = await environmentRepo.listAcpAgentsByUserId(currentUser.id);
    return agents.map((a) => toAcpAgentResponse(a));
  }, { sessionAuth: true })

  /** WS /acp/ws — WebSocket endpoint for acp-link connections */
  .ws("/ws", {
    async open(ws) {
      // Authenticate via API key
      const url = new URL(ws.data.request.url);
      const authHeader = ws.data.request.headers.get("Authorization");
      const queryToken = url.searchParams.get("token");
      const token = authHeader?.replace("Bearer ", "") || queryToken || undefined;

      const conn = adaptWs(ws);

      if (!token) {
        log("[ACP-WS] Upgrade rejected: missing token");
        conn.close(4003, "unauthorized");
        return;
      }

      const authResult = await resolveTokenAuth(token);
      if (!authResult) {
        log("[ACP-WS] Upgrade rejected: invalid API key");
        conn.close(4003, "unauthorized");
        return;
      }

      const wsId = `acp_ws_${uuid().replace(/-/g, "")}`;
      (ws.data as any).__acpWsId = wsId;
      log(`[ACP-WS] Upgrade accepted: wsId=${wsId} userId=${authResult.userId}`);
      handleAcpWsOpen(conn, wsId, authResult.userId, authResult.envId);
    },
    message(ws, data) {
      // Elysia's parseMessage auto-parses JSON strings into objects;
      // pass the already-parsed object directly to avoid redundant stringify→parse.
      if (typeof data === "string" && data.length > MAX_WS_MESSAGE_SIZE) {
        logError(`[ACP-WS] Message too large: ${data.length} bytes`);
        adaptWs(ws).close(1009, "message too large");
        return;
      }
      const wsId = (ws.data as any).__acpWsId as string | undefined;
      if (wsId) {
        handleAcpWsMessage(adaptWs(ws), wsId, data as string | Record<string, unknown>);
      }
    },
    close(ws, code, reason) {
      const wsId = (ws.data as any).__acpWsId as string | undefined;
      if (wsId) {
        handleAcpWsClose(adaptWs(ws), wsId, code, reason);
      }
    },
  })

  /** WS /acp/relay/:agentId — WebSocket relay for frontend to interact with an agent */
  .ws("/relay/:agentId", {
    async open(ws) {
      // Authenticate via better-auth session
      const session = await auth.api.getSession({ headers: ws.data.request.headers });
      if (!session?.user) {
        log("[ACP-Relay] Upgrade rejected: not authenticated");
        adaptWs(ws).close(4003, "unauthorized");
        return;
      }

      const userId = session.user.id;
      const agentId = ws.data.params.agentId;
      const sessionId = ws.data.query?.sessionId as string | undefined;

      // Verify agent belongs to this user
      const env = await environmentRepo.getById(agentId);
      if (!env || env.userId !== userId) {
        log(`[ACP-Relay] Upgrade rejected: agent ${agentId} not found or not owned by user ${userId}`);
        adaptWs(ws).close(4003, "unauthorized");
        return;
      }

      const relayWsId = `relay_${uuid().replace(/-/g, "")}`;
      (ws.data as any).__relayWsId = relayWsId;

      log(`[ACP-Relay] Upgrade accepted: relayWsId=${relayWsId} agentId=${agentId}`);
      handleRelayOpen(adaptWs(ws), relayWsId, agentId, userId, sessionId);
    },
    message(ws, data) {
      // Elysia's parseMessage auto-parses JSON strings into objects;
      // pass the already-parsed object directly to avoid redundant stringify→parse.
      if (typeof data === "string" && data.length > MAX_WS_MESSAGE_SIZE) {
        logError(`[ACP-Relay] Message too large: ${data.length} bytes`);
        adaptWs(ws).close(1009, "message too large");
        return;
      }
      const relayWsId = (ws.data as any).__relayWsId as string | undefined;
      if (relayWsId) {
        const payload = typeof data === "object" && data !== null
          ? data as Record<string, unknown>
          : data as string;
        handleRelayMessage(adaptWs(ws), relayWsId, payload);
      } else {
        logError(`[ACP-Relay-WS] No relayWsId on ws.data`);
      }
    },
    close(ws, code, reason) {
      const relayWsId = (ws.data as any).__relayWsId as string | undefined;
      if (relayWsId) {
        handleRelayClose(adaptWs(ws), relayWsId, code, reason);
      }
    },
  });

export default app;
