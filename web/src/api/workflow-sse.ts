/**
 * Workflow SSE 实时事件客户端。
 *
 * 封装 EventSource 连接管理，同一时间只维护一个连接。
 * 支持 fromSeqNum 断线重连。
 */

export interface WorkflowSSEEvent {
  type: string;
  workflowId: string;
  [key: string]: unknown;
}

let currentES: EventSource | null = null;
let lastSeqNum = 0;

/**
 * 连接 workflow SSE 事件流。
 * 同一时间只维护一个连接（调用时会自动断开旧连接）。
 */
export function connectWorkflowSSE(workflowId: string, onEvent: (event: WorkflowSSEEvent) => void): void {
  disconnectWorkflowSSE();

  const url = `/web/workflow/${encodeURIComponent(workflowId)}/events${
    lastSeqNum > 0 ? `?fromSeqNum=${lastSeqNum}` : ""
  }`;
  const es = new EventSource(url, { withCredentials: true });
  currentES = es;

  es.addEventListener("message", (e: MessageEvent) => {
    try {
      const seqNum = Number(e.lastEventId);
      if (seqNum && seqNum <= lastSeqNum) return;
      if (seqNum) lastSeqNum = seqNum;

      const data = JSON.parse(e.data) as WorkflowSSEEvent;
      onEvent(data);
    } catch {
      // ignore parse errors
    }
  });

  es.addEventListener("error", () => {
    // EventSource 自动重连
  });
}

/** 断开 workflow SSE 连接 */
export function disconnectWorkflowSSE(): void {
  if (currentES) {
    currentES.close();
    currentES = null;
  }
  lastSeqNum = 0;
}
