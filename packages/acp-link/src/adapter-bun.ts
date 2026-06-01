/**
 * Bun 原生 WebSocket 服务器适配器。
 * 仅在 Bun 运行时下被加载。
 */

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

export function startBunWsServer(port: number, host: string, callbacks: WsServerCallbacks): WsServerHandle {
  // biome-ignore lint/suspicious/noExplicitAny: Bun global is not typed in this package
  const Bun = (globalThis as any).Bun;

  const server = Bun.serve({
    port,
    hostname: host,
    fetch(req: Request, server: { upgrade(req: Request): boolean }) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }
      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }
      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open(ws: unknown) {
        callbacks.open(ws);
      },
      async message(ws: unknown, raw: unknown) {
        callbacks.message(ws, raw);
      },
      close(ws: unknown) {
        callbacks.close(ws);
      },
      pong(ws: unknown) {
        callbacks.pong(ws);
      },
    },
  });

  return {
    port: server.port as number,
    stop: () => server.stop(),
  };
}
