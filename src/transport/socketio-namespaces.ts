import type { IncomingMessage } from "node:http";
import type { Server, Socket } from "socket.io";
import { v4 as uuid } from "uuid";
import { validateEnv } from "../env";
import { AppError } from "../errors";
import type { RequestAuthResult } from "../plugins/auth";
import { authenticateRequest } from "../plugins/auth";
import { handleAcpWsClose, handleAcpWsMessage, handleAcpWsOpen } from "./acp-ws-handler";
import { handleFileWsClose, handleFileWsMessage, handleFileWsOpen } from "./file-ws-handler";
import { handleRelayClose, handleRelayMessage, handleRelayOpen } from "./relay";
import type { WsConnection } from "./ws-types";

/** Convert Node IncomingMessage to a Fetch API Request for authenticateRequest */
function incomingToRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }
  }

  const protocol = (req.headers["x-forwarded-proto"] as string) === "https" ? "https" : "http";
  const host = (req.headers.host as string) || "localhost";
  const url = req.url || "/";
  const fullUrl = `${protocol}://${host}${url}`;

  return new Request(fullUrl, { headers });
}

/** Adapt socket.io Socket to WsConnection interface */
function socketToWsConn(socket: Socket): WsConnection {
  return {
    send: (data: string) => socket.send(data),
    close: (_code?: number, _reason?: string) => {
      socket.disconnect();
    },
    get readyState() {
      return socket.connected ? 1 : 3;
    },
  };
}

/** Register all socket.io namespace connection handlers */
export function registerNamespaces(io: Server): void {
  // ── /relay — frontend chat relay, cookie auth ──
  io.of("/relay")
    .use(async (socket, next) => {
      let authResult: RequestAuthResult | null = null;
      const request = incomingToRequest(socket.request);
      try {
        authResult = await authenticateRequest(request);
      } catch (err) {
        if (err instanceof AppError && err.code === "RATE_LIMITED") {
          return next(new Error("rate_limited"));
        }
        return next(new Error("unauthorized"));
      }
      if (!authResult?.user) {
        return next(new Error("unauthorized"));
      }

      const agentId = socket.handshake.query.agentId as string;
      if (!agentId) {
        return next(new Error("missing agentId"));
      }

      // biome-ignore lint/suspicious/noExplicitAny: socket.data is any by Socket.IO design
      (socket.data as any).authResult = authResult;
      // biome-ignore lint/suspicious/noExplicitAny: socket.data is any by Socket.IO design
      (socket.data as any).userId = authResult.user.id;
      // biome-ignore lint/suspicious/noExplicitAny: socket.data is any by Socket.IO design
      (socket.data as any).agentId = agentId;
      // biome-ignore lint/suspicious/noExplicitAny: socket.data is any by Socket.IO design
      (socket.data as any).sessionId = (socket.handshake.query.sessionId as string) || undefined;

      // Verify agent exists and check org permissions
      const { environmentRepo } = await import("../repositories/environment");
      const env = await environmentRepo.getById(agentId);
      if (!env) {
        return next(new Error("agent not found"));
      }

      const userId = authResult.user.id;
      const authCtx = authResult.authContext;
      const forbiddenSharedRuntime = Boolean(env.agentConfigId && env.userId !== userId);
      if (
        !authCtx ||
        forbiddenSharedRuntime ||
        (env.organizationId !== authCtx.organizationId && env.userId !== userId)
      ) {
        return next(new Error("unauthorized"));
      }

      next();
    })
    .on("connection", (socket) => {
      const wsId = `relay_${uuid().replace(/-/g, "")}`;
      const ws = socketToWsConn(socket);
      // biome-ignore lint/suspicious/noExplicitAny: socket.data is any by Socket.IO design
      const { agentId, userId, sessionId } = socket.data as any;
      handleRelayOpen(ws, wsId, agentId, userId, sessionId);

      socket.on("message", (data) => {
        handleRelayMessage(ws, wsId, typeof data === "string" ? data : (data as Record<string, unknown>));
      });

      socket.on("disconnect", (reason) => {
        handleRelayClose(ws, wsId, undefined, reason);
      });
    });

  // ── /machine — machine WS, secret auth ──
  io.of("/machine")
    .use((socket, next) => {
      const secret = socket.handshake.query.secret as string;
      const registrySecret = validateEnv().REGISTRY_SECRET;
      if (!secret || !registrySecret || secret !== registrySecret) {
        return next(new Error("unauthorized"));
      }
      next();
    })
    .on("connection", (socket) => {
      const wsId = `acp_ws_${uuid().replace(/-/g, "")}`;
      const ws = socketToWsConn(socket);
      handleAcpWsOpen(ws, wsId, "__machine__", null, true);

      socket.on("message", (data) => {
        handleAcpWsMessage(
          ws,
          wsId,
          typeof data === "object" && data !== null ? (data as Record<string, unknown>) : (data as string),
        );
      });

      socket.on("disconnect", (reason) => {
        handleAcpWsClose(ws, wsId, undefined, reason);
      });
    });

  // ── /file — file WS, secret auth ──
  io.of("/file")
    .use((socket, next) => {
      const secret = socket.handshake.query.secret as string;
      const registrySecret = validateEnv().REGISTRY_SECRET;
      if (!secret || !registrySecret || secret !== registrySecret) {
        return next(new Error("unauthorized"));
      }
      next();
    })
    .on("connection", (socket) => {
      const wsId = `file_ws_${uuid().replace(/-/g, "")}`;
      const ws = socketToWsConn(socket);
      handleFileWsOpen(ws, wsId);

      socket.on("message", (data) => {
        handleFileWsMessage(
          ws,
          wsId,
          typeof data === "object" && data !== null ? (data as Record<string, unknown>) : (data as string),
        );
      });

      socket.on("disconnect", () => {
        handleFileWsClose(ws, wsId);
      });
    });
}
