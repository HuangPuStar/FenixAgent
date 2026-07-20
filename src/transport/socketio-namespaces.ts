import type { Server, Socket } from "socket.io";
import { v4 as uuid } from "uuid";
import { validateEnv } from "../env";
import { handleAcpWsClose, handleAcpWsMessage, handleAcpWsOpen } from "./acp-ws-handler";
import { handleFileWsClose, handleFileWsMessage, handleFileWsOpen } from "./file-ws-handler";
import { handleRelayClose, handleRelayMessage, handleRelayOpen } from "./relay";
import { type RelaySocketData, relayAuthMiddleware } from "./socketio-auth";
import type { WsConnection } from "./ws-types";

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

/**
 * 注册 socket.io 的几个 namespace 连接处理器。
 *
 * 注册三个 namespace 及其认证与消息路由：
 * - `/relay`：前端 chat relay，cookie auth，agent 权限校验
 * - `/machine`：远端机器 WS，secret auth，message 路由到 acp-ws-handler
 * - `/file`：文件传输 WS，secret auth，message 路由到 file-ws-handler
 *
 * @param io - socket.io Server 实例
 */
export function registerNamespaces(io: Server): void {
  // ── /relay — frontend chat relay, cookie auth via relayAuthMiddleware ──
  io.of("/relay")
    .use(relayAuthMiddleware)
    .on("connection", (socket) => {
      const wsId = `relay_${uuid().replace(/-/g, "")}`;
      const ws = socketToWsConn(socket);
      const { agentId, userId, sessionId } = socket.data as RelaySocketData;
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
