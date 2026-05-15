import { log, error as logError } from "../../logger";
import Elysia from "elysia";
import { errorResponse } from "../../plugins/auth";
import { validateLegacyApiKey } from "../../auth/api-key-service";
import { verifyWorkerJwt } from "../../auth/jwt";
import {
  handleWebSocketOpen,
  handleWebSocketMessage,
  handleWebSocketClose,
  ingestBridgeMessage,
} from "../../transport/ws-handler";
import { getSession, resolveExistingSessionId } from "../../services/session";
import type { WsConnection } from "../../transport/ws-types";

function adaptWs(ws: any): WsConnection {
  return {
    send: (data: string) => ws.send(data),
    close: (code?: number, reason?: string) => ws.close(code, reason),
    get readyState() { return ws.readyState; },
  };
}

/** Authenticate via API key or worker JWT in Authorization header or ?token= query param */
function authenticateRequest(request: Request, label: string, expectedSessionId?: string): boolean {
  const authHeader = request.headers.get("Authorization") ?? undefined;
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token") ?? undefined;
  const token = authHeader?.replace("Bearer ", "") || queryToken;

  // Try API key first
  if (validateLegacyApiKey(token)) {
    return true;
  }

  // Try JWT verification — validate session_id matches if provided
  if (token) {
    const payload = verifyWorkerJwt(token);
    if (payload) {
      if (expectedSessionId && payload.session_id !== expectedSessionId) {
        log(`[Auth] ${label}: FAILED — JWT session_id mismatch`);
        return false;
      }
      return true;
    }
  }

  log(`[Auth] ${label}: FAILED — no valid API key or JWT`);
  return false;
}

const app = new Elysia({ name: "v2-session-ingress", prefix: "/v2/session_ingress" })
  .decorate({ error: errorResponse });

/** POST /v2/session_ingress/session/:sessionId/events — HTTP POST (HybridTransport writes) */
app.post("/session/:sessionId/events", async ({ request, params, error }) => {
  const requestedSessionId = params.sessionId;
  const sessionId = await resolveExistingSessionId(requestedSessionId) ?? requestedSessionId;

  if (!authenticateRequest(request, `POST session/${sessionId}`, sessionId)) {
    return error(401, { error: { type: "unauthorized", message: "Invalid auth" } });
  }

  const session = getSession(sessionId);
  if (!session) {
    return error(404, { error: { type: "not_found", message: "Session not found" } });
  }

  const body = await request.json();
  const events = Array.isArray(body.events) ? body.events : [body];

  let count = 0;
  for (const msg of events) {
    if (!msg || typeof msg !== "object") continue;
    ingestBridgeMessage(sessionId, msg as Record<string, unknown>);
    count++;
  }

  return { status: "ok" };
});

/** WS /v2/session_ingress/ws/:sessionId — WebSocket transport */
app.ws("/ws/:sessionId", {
  async open(ws) {
    const requestedSessionId = ws.data.params.sessionId;
    const sessionId = await resolveExistingSessionId(requestedSessionId) ?? requestedSessionId;

    if (!authenticateRequest(ws.data.request, `WS ${sessionId}`, sessionId)) {
      ws.close(4003, "unauthorized");
      return;
    }

    const session = getSession(sessionId);
    if (!session) {
      log(`[WS] Upgrade rejected: session ${sessionId} not found`);
      ws.close(4001, "session not found");
      return;
    }

    log(`[WS] Upgrade accepted: session=${sessionId}`);
    handleWebSocketOpen(adaptWs(ws), sessionId);
  },
  async message(ws, message) {
    const requestedSessionId = ws.data.params.sessionId;
    const sessionId = await resolveExistingSessionId(requestedSessionId) ?? requestedSessionId;
    const data = typeof message === "string"
      ? message
      : new TextDecoder().decode(message as ArrayBuffer);
    handleWebSocketMessage(adaptWs(ws), sessionId, data);
  },
  async close(ws, code, reason) {
    const requestedSessionId = ws.data.params.sessionId;
    const sessionId = await resolveExistingSessionId(requestedSessionId) ?? requestedSessionId;
    handleWebSocketClose(adaptWs(ws), sessionId, code, reason);
  },
});

export default app;
