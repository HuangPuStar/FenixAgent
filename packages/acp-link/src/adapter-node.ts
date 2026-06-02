/**
 * Node.js WebSocket 服务器适配器（使用 http + ws 库）。
 * 仅在 Node.js 运行时下被加载。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import type WebSocket from "ws";

const require = createRequire(import.meta.url);
const http = require("node:http");
const { WebSocketServer } = require("ws");

export interface WsServerCallbacks {
  open(ws: unknown): void;
  message(ws: unknown, raw: unknown): void;
  close(ws: unknown): void;
  pong(ws: unknown): void;
}

export interface WsServerHandle {
  port: number;
  stop(): void;
}

export function startNodeWsServer(port: number, host: string, callbacks: WsServerCallbacks): WsServerHandle {
  const httpServer = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end("Not Found");
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (req.url === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws: unknown) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    callbacks.open(ws);

    ws.on("message", (data: unknown) => {
      callbacks.message(ws, data);
    });

    ws.on("close", () => {
      callbacks.close(ws);
    });

    ws.on("pong", () => {
      callbacks.pong(ws);
    });
  });

  httpServer.listen(port, host);

  return {
    port,
    stop: () => {
      wss.close();
      httpServer.close();
    },
  };
}
