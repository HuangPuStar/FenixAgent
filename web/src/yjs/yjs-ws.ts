/**
 * 极简 YJS WebSocket 客户端。
 * 只做一件事：接收服务端 yjs:update 消息，应用到本地 Y.Doc。
 * 出站操作通过简单的 JSON 消息发送，不再经过 ACP JSON-RPC 协议栈。
 */

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

/** Build the YJS WebSocket URL for a given agent */
export function buildYjsUrl(agentId: string, sessionId?: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${protocol}//${window.location.host}/acp/yjs/${agentId}`;
  const params = new URLSearchParams();
  const activeOrgId = localStorage.getItem("active_org_id");
  if (activeOrgId) {
    params.set("active_org_id", activeOrgId);
  }
  if (sessionId) {
    params.set("sessionId", sessionId);
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export type YjsUpdateHandler = (docName: string, data: Uint8Array) => void;
export type ConnectionStateHandler = (state: YjsWsState) => void;

export type YjsWsState = "connecting" | "connected" | "disconnected";

export interface YjsWsOptions {
  url: string;
  onYjsUpdate: YjsUpdateHandler;
  onConnectionState?: ConnectionStateHandler;
}

export function createYjsWs(options: YjsWsOptions) {
  const { url, onYjsUpdate, onConnectionState } = options;

  let ws: WebSocket | null = null;
  let reconnectDelayIdx = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  function setState(state: YjsWsState) {
    onConnectionState?.(state);
  }

  function scheduleReconnect() {
    if (destroyed) return;
    const delay = RECONNECT_DELAYS[reconnectDelayIdx] ?? RECONNECT_DELAYS[RECONNECT_DELAYS.length - 1];
    reconnectTimer = setTimeout(() => {
      if (destroyed) return;
      reconnectDelayIdx = Math.min(reconnectDelayIdx + 1, RECONNECT_DELAYS.length - 1);
      connect();
    }, delay);
  }

  function connect() {
    if (destroyed) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    setState("connecting");
    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectDelayIdx = 0;
      setState("connected");
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;
        if (msg.type === "yjs:update") {
          const docName = msg.docName as string;
          const base64 = msg.data as string;
          if (docName && base64) {
            const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
            onYjsUpdate(docName, binary);
          }
        }
      } catch {
        console.warn("[yjs-ws] failed to parse msg:", event.data?.slice(0, 100));
      }
    };

    ws.onclose = () => {
      ws = null;
      setState("disconnected");
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose 会跟随触发，统一处理
    };
  }

  function disconnect() {
    destroyed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
    setState("disconnected");
  }

  function send(data: unknown) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    } else {
      console.warn("[yjs-ws] send FAILED: ws readyState=", ws?.readyState);
    }
  }

  function isConnected() {
    return ws?.readyState === WebSocket.OPEN;
  }

  return { connect, disconnect, send, isConnected };
}
