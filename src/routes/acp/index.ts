import { log, error as logError } from "@fenix/logger";
import Elysia from "elysia";
import { v4 as uuid } from "uuid";
import { auth } from "../../auth/better-auth";
import { validateEnv } from "../../env";
import { authGuardPlugin } from "../../plugins/auth";
import { environmentRepo } from "../../repositories";
import { handleAcpWsClose, handleAcpWsMessage, handleAcpWsOpen } from "../../transport/acp-ws-handler";
import { handleFileWsClose, handleFileWsMessage, handleFileWsOpen } from "../../transport/file-ws-handler";
import { handleRelayClose, handleRelayMessage, handleRelayOpen } from "../../transport/relay";
import type { WsConnection } from "../../transport/ws-types";

/** Maximum WebSocket message size: 10 MB */
const MAX_WS_MESSAGE_SIZE = 10 * 1024 * 1024;

/** Adapt Elysia WS to WsConnection interface */
// biome-ignore lint/suspicious/noExplicitAny: Elysia WS type not directly compatible with WsConnection
function adaptWs(ws: any): WsConnection {
  return {
    send: (data: string) => ws.send(data),
    close: (code?: number, reason?: string) => ws.close(code, reason),
    get readyState() {
      return ws.readyState;
    },
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

const app = new Elysia({ name: "acp", prefix: "/acp" })
  .use(authGuardPlugin)

  /** GET /acp/agents — List current user's team ACP agents */
  .get(
    "/agents",
    async ({ store }) => {
      const authCtx = store.authContext;
      const orgId = authCtx?.organizationId ?? store.user!.id;
      const teamEnvs = await environmentRepo.listByOrganizationId(orgId);
      const acpEnvs = teamEnvs.filter((e) => e.workerType === "acp");
      return acpEnvs.map((a) => toAcpAgentResponse(a));
    },
    { sessionAuth: true },
  )

  /** WS /acp/ws — WebSocket endpoint for acp-link connections */
  .ws("/ws", {
    async open(ws) {
      const url = new URL(ws.data.request.url);
      const secret = url.searchParams.get("secret");
      const registrySecret = validateEnv().REGISTRY_SECRET;

      if (!secret || !registrySecret || secret !== registrySecret) {
        log("[ACP-WS] Upgrade rejected: invalid or missing registry secret");
        adaptWs(ws).close(4003, "unauthorized");
        return;
      }

      const wsId = `acp_ws_${uuid().replace(/-/g, "")}`;
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension
      (ws.data as any).__acpWsId = wsId;
      log(`[ACP-WS] Machine upgrade accepted: wsId=${wsId} secret matched`);
      handleAcpWsOpen(adaptWs(ws), wsId, "__machine__", null, true);
    },
    message(ws, data) {
      // Elysia's parseMessage auto-parses JSON strings into objects;
      // pass the already-parsed object directly to avoid redundant stringify→parse.
      if (typeof data === "string" && data.length > MAX_WS_MESSAGE_SIZE) {
        logError(`[ACP-WS] Message too large: ${data.length} bytes`);
        adaptWs(ws).close(1009, "message too large");
        return;
      }
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const wsId = (ws.data as any).__acpWsId as string | undefined;
      if (wsId) {
        handleAcpWsMessage(adaptWs(ws), wsId, data as string | Record<string, unknown>);
      }
    },
    close(ws, code, reason) {
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const wsId = (ws.data as any).__acpWsId as string | undefined;
      if (wsId) {
        handleAcpWsClose(adaptWs(ws), wsId, code, reason);
      }
    },
  })

  /** WS /acp/file-ws — WebSocket endpoint for remote file operations */
  .ws("/file-ws", {
    async open(ws) {
      const url = new URL(ws.data.request.url);
      const secret = url.searchParams.get("secret");
      const registrySecret = validateEnv().REGISTRY_SECRET;

      if (!secret || !registrySecret || secret !== registrySecret) {
        log("[File-WS] Upgrade rejected: invalid or missing registry secret");
        adaptWs(ws).close(4003, "unauthorized");
        return;
      }

      const wsId = `file_ws_${uuid().replace(/-/g, "")}`;
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension
      (ws.data as any).__fileWsId = wsId;
      log(`[File-WS] Upgrade accepted: wsId=${wsId}`);
      handleFileWsOpen(adaptWs(ws), wsId);
    },
    message(ws, data) {
      if (typeof data === "string" && data.length > MAX_WS_MESSAGE_SIZE) {
        logError(`[File-WS] Message too large: ${data.length} bytes`);
        adaptWs(ws).close(1009, "message too large");
        return;
      }
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const wsId = (ws.data as any).__fileWsId as string | undefined;
      if (wsId) {
        handleFileWsMessage(adaptWs(ws), wsId, data as string | Record<string, unknown>);
      }
    },
    close(ws, _code, _reason) {
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const wsId = (ws.data as any).__fileWsId as string | undefined;
      if (wsId) {
        handleFileWsClose(adaptWs(ws), wsId);
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

      // Verify agent belongs to this user's team
      const env = await environmentRepo.getById(agentId);
      if (!env) {
        log(`[ACP-Relay] Upgrade rejected: agent ${agentId} not found`);
        adaptWs(ws).close(4003, "unauthorized");
        return;
      }
      // 验证团队归属：env.organizationId 或 env.userId 必须匹配
      const { loadOrgContext } = await import("../../services/org-context");
      const authCtx = await loadOrgContext({ id: userId }, ws.data.request);
      if (!authCtx || (env.organizationId !== authCtx.organizationId && env.userId !== userId)) {
        log(`[ACP-Relay] Upgrade rejected: agent ${agentId} not owned by user ${userId}'s team`);
        adaptWs(ws).close(4003, "unauthorized");
        return;
      }

      const relayWsId = `relay_${uuid().replace(/-/g, "")}`;
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
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
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const relayWsId = (ws.data as any).__relayWsId as string | undefined;
      if (relayWsId) {
        const payload =
          typeof data === "object" && data !== null ? (data as Record<string, unknown>) : (data as string);
        handleRelayMessage(adaptWs(ws), relayWsId, payload);
      } else {
        logError(`[ACP-Relay-WS] No relayWsId on ws.data`);
      }
    },
    close(ws, code, reason) {
      // biome-ignore lint/suspicious/noExplicitAny: Elysia WS data extension pattern
      const relayWsId = (ws.data as any).__relayWsId as string | undefined;
      if (relayWsId) {
        handleRelayClose(adaptWs(ws), relayWsId, code, reason);
      }
    },
  });

export default app;
