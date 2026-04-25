import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { sessionAuth } from "../../auth/middleware";
import { validateApiKeyAndGetUser } from "../../auth/api-key-service";
import { auth } from "../../auth/better-auth";
import { config } from "../../config";
import { db } from "../../db";
import { user } from "../../db/schema";
import { eq } from "drizzle-orm";
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
import {
  storeListAcpAgentsByUserId,
  storeGetEnvironment,
} from "../../store";
import { log, error as logError } from "../../logger";

const app = new Hono();

/** Maximum WebSocket message size: 10 MB */
const MAX_WS_MESSAGE_SIZE = 10 * 1024 * 1024;

/** Response shape for an ACP agent */
function toAcpAgentResponse(env: NonNullable<ReturnType<typeof storeGetEnvironment>>) {
  return {
    id: env.id,
    agent_name: env.machineName,
    status: env.status === "active" ? "online" : "offline",
    max_sessions: env.maxSessions,
    last_seen_at: env.lastPollAt ? env.lastPollAt.getTime() / 1000 : null,
    created_at: env.createdAt.getTime() / 1000,
  };
}

/**
 * Find or create the system user for legacy global API key fallback.
 * Mirrors the logic in auth/middleware.ts ensureSystemUser.
 */
async function ensureSystemUser(): Promise<{ id: string; email: string; name: string } | null> {
  const rows = await db.select().from(user).where(eq(user.email, "system@rcs.local")).limit(1);
  if (rows.length > 0) {
    return { id: rows[0].id, email: rows[0].email, name: rows[0].name };
  }

  const anyUser = await db.select().from(user).limit(1);
  if (anyUser.length > 0) {
    return { id: anyUser[0].id, email: anyUser[0].email, name: anyUser[0].name };
  }

  try {
    const result = await auth.api.signUpEmail({
      email: "system@rcs.local",
      password: "system",
      name: "System",
    });
    if (result.user) {
      const { createApiKey } = await import("../../auth/api-key-service");
      await createApiKey(result.user.id, "legacy-auto");
      return { id: result.user.id, email: result.user.email, name: result.user.name };
    }
  } catch {
    // signUpEmail may fail if user was created concurrently
  }

  return null;
}

/** GET /acp/agents — List current user's ACP agents */
app.get("/agents", sessionAuth, async (c) => {
  const user = c.get("user")!;
  const agents = storeListAcpAgentsByUserId(user.id);
  return c.json(agents.map((a) => toAcpAgentResponse(a)));
});

/** WS /acp/ws — WebSocket endpoint for acp-link connections */
app.get(
  "/ws",
  upgradeWebSocket(async (c) => {
    // Authenticate via API key
    const authHeader = c.req.header("Authorization");
    const queryToken = c.req.query("token");
    const token = authHeader?.replace("Bearer ", "") || queryToken;

    if (!token) {
      log("[ACP-WS] Upgrade rejected: missing token");
      return {
        onOpen(_evt: any, ws: any) {
          ws.close(4003, "unauthorized");
        },
      };
    }

    let userId: string | undefined;

    // 1. Try per-user API Key (SQLite)
    const keyInfo = await validateApiKeyAndGetUser(token);
    if (keyInfo) {
      const [userRow] = await db.select().from(user).where(eq(user.id, keyInfo.userId)).limit(1);
      if (userRow) {
        userId = userRow.id;
      }
    }

    // 2. Fallback: legacy global API Key (RCS_API_KEYS env var)
    if (!userId && config.apiKeys.length > 0 && config.apiKeys.includes(token)) {
      const systemUser = await ensureSystemUser();
      if (systemUser) {
        userId = systemUser.id;
      }
    }

    if (!userId) {
      log("[ACP-WS] Upgrade rejected: invalid API key");
      return {
        onOpen(_evt: any, ws: any) {
          ws.close(4003, "unauthorized");
        },
      };
    }

    // Generate unique wsId for this connection
    const { v4: uuid } = await import("uuid");
    const wsId = `acp_ws_${uuid().replace(/-/g, "")}`;

    log(`[ACP-WS] Upgrade accepted: wsId=${wsId} userId=${userId}`);
    return {
      onOpen(_evt: any, ws: any) {
        handleAcpWsOpen(ws, wsId, userId);
      },
      onMessage(evt: any, ws: any) {
        const data =
          typeof evt.data === "string"
            ? evt.data
            : new TextDecoder().decode(evt.data as ArrayBuffer);
        if (data.length > MAX_WS_MESSAGE_SIZE) {
          logError(`[ACP-WS] Message too large on wsId=${wsId}: ${data.length} bytes`);
          ws.close(1009, "message too large");
          return;
        }
        handleAcpWsMessage(ws, wsId, data);
      },
      onClose(evt: any, ws: any) {
        const closeEvt = evt as unknown as CloseEvent;
        handleAcpWsClose(ws, wsId, closeEvt?.code, closeEvt?.reason);
      },
      onError(evt: any, ws: any) {
        logError(`[ACP-WS] Error on wsId=${wsId}:`, evt);
        handleAcpWsClose(ws, wsId, 1006, "websocket error");
      },
    };
  }),
);

/** WS /acp/relay/:agentId — WebSocket relay for frontend to interact with an agent */
app.get(
  "/relay/:agentId",
  upgradeWebSocket(async (c) => {
    // Authenticate via better-auth session (cookie-based)
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (!session?.user) {
      log("[ACP-Relay] Upgrade rejected: not authenticated");
      return {
        onOpen(_evt: any, ws: any) {
          ws.close(4003, "unauthorized");
        },
      };
    }

    const userId = session.user.id;
    const agentId = c.req.param("agentId")!;

    // Verify agent belongs to this user
    const env = storeGetEnvironment(agentId);
    if (!env || env.userId !== userId) {
      log(`[ACP-Relay] Upgrade rejected: agent ${agentId} not found or not owned by user ${userId}`);
      return {
        onOpen(_evt: any, ws: any) {
          ws.close(4003, "unauthorized");
        },
      };
    }

    const { v4: uuid } = await import("uuid");
    const relayWsId = `relay_${uuid().replace(/-/g, "")}`;

    log(`[ACP-Relay] Upgrade accepted: relayWsId=${relayWsId} agentId=${agentId}`);
    return {
      onOpen(_evt: any, ws: any) {
        handleRelayOpen(ws, relayWsId, agentId, userId);
      },
      onMessage(evt: any, ws: any) {
        const data =
          typeof evt.data === "string"
            ? evt.data
            : new TextDecoder().decode(evt.data as ArrayBuffer);
        if (data.length > MAX_WS_MESSAGE_SIZE) {
          logError(`[ACP-Relay] Message too large on relayWsId=${relayWsId}: ${data.length} bytes`);
          ws.close(1009, "message too large");
          return;
        }
        handleRelayMessage(ws, relayWsId, data);
      },
      onClose(evt: any, ws: any) {
        const closeEvt = evt as unknown as CloseEvent;
        handleRelayClose(ws, relayWsId, closeEvt?.code, closeEvt?.reason);
      },
      onError(evt: any, ws: any) {
        logError(`[ACP-Relay] Error on relayWsId=${relayWsId}:`, evt);
        handleRelayClose(ws, relayWsId, 1006, "websocket error");
      },
    };
  }),
);

export default app;
