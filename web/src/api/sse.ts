import type { SessionEvent } from "../types";

let currentEventSource: EventSource | null = null;

/**
 * 连接会话 SSE 事件流（GET /web/sessions/:id/events）。
 * 后端使用 session cookie 认证，EventSource 默认携带 cookie。
 *
 * @param sessionId 会话 ID
 * @param onEvent 事件回调
 * @param fromSeqNum 断线重连起始序号，通过 Last-Event-ID header 传递
 */
export function connectSSE(sessionId: string, onEvent: (event: SessionEvent) => void, fromSeqNum = 0): void {
  disconnectSSE();

  // EventSource 不支持自定义 header，断线重连序号通过 URL query 传递
  const params = new URLSearchParams();
  if (fromSeqNum > 0) params.set("fromSeqNum", String(fromSeqNum));
  const qs = params.toString();
  const url = qs ? `/web/sessions/${sessionId}/events?${qs}` : `/web/sessions/${sessionId}/events`;
  const es = new EventSource(url, { withCredentials: true });
  currentEventSource = es;

  let lastSeenSeq = fromSeqNum;

  es.addEventListener("message", (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as SessionEvent;
      if (data.seqNum !== undefined && data.seqNum <= lastSeenSeq) return;
      if (data.seqNum !== undefined) lastSeenSeq = data.seqNum;
      onEvent(data);
    } catch {
      // ignore parse errors
    }
  });

  es.addEventListener("error", () => {
    // EventSource auto-reconnects
  });
}

export function disconnectSSE(): void {
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }
}
