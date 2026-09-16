/**
 * Workflow SSE 实时事件客户端。
 *
 * 每个 workflowId 独立维护一个 EventSource 连接。
 * 支持 fromSeqNum 断线重连。
 *
 * 历史问题：早期实现使用模块级单例 EventSource + lastSeqNum，多个组件订阅会相互覆盖，
 * 切换 workflow 时 lastSeqNum 会错乱。现在按 workflowId 分桶管理连接与序号。
 */

export interface WorkflowSSEEvent {
  type: string;
  workflowId: string;
  [key: string]: unknown;
}

interface ConnectionState {
  es: EventSource;
  lastSeqNum: number;
}

// 按 workflowId 维护独立连接
const connections = new Map<string, ConnectionState>();

/**
 * 连接指定 workflow 的 SSE 事件流。
 * 同一 workflowId 多次调用会复用现有连接；onEvent 会被附加到最新连接。
 */
export function connectWorkflowSSE(workflowId: string, onEvent: (event: WorkflowSSEEvent) => void): void {
  // 先取 prevSeq 再 disconnect：disconnect 内部会 delete state，
  // 顺序反了会让 prevSeq 永远是 0，每次重连都重放全部历史事件。
  const prevSeq = connections.get(workflowId)?.lastSeqNum ?? 0;
  // 已存在连接则先关闭重建，保证 onEvent 是最新的
  disconnectWorkflowSSE(workflowId);

  const url = `/web/workflow/${encodeURIComponent(workflowId)}/events${prevSeq > 0 ? `?fromSeqNum=${prevSeq}` : ""}`;
  const es = new EventSource(url, { withCredentials: true });
  const state: ConnectionState = { es, lastSeqNum: prevSeq };
  connections.set(workflowId, state);

  es.addEventListener("message", (e: MessageEvent) => {
    try {
      const seqNum = Number(e.lastEventId);
      if (seqNum && seqNum <= state.lastSeqNum) return;
      if (seqNum) state.lastSeqNum = seqNum;

      const data = JSON.parse(e.data) as WorkflowSSEEvent;
      onEvent(data);
    } catch {
      // ignore parse errors
    }
  });

  es.addEventListener("error", () => {
    // EventSource 自动重连；不动 state.lastSeqNum 以便重连后从断点续传
  });
}

/** 断开指定 workflow 的 SSE 连接（不重置 lastSeqNum，便于外部按需 resume） */
export function disconnectWorkflowSSE(workflowId?: string): void {
  if (!workflowId) {
    // 向后兼容：未传 workflowId 时关闭所有连接
    for (const [, state] of connections) {
      state.es.close();
    }
    connections.clear();
    return;
  }
  const state = connections.get(workflowId);
  if (state) {
    state.es.close();
    connections.delete(workflowId);
  }
}

/** 完全清理指定 workflow 的 SSE 状态（连接 + lastSeqNum） */
export function resetWorkflowSSE(workflowId: string): void {
  disconnectWorkflowSSE(workflowId);
  // delete 后下次重连会从 seqNum=0 开始
}

/** 查询当前是否仍持有指定 workflow 的活动连接 */
export function hasWorkflowSSE(workflowId: string): boolean {
  const state = connections.get(workflowId);
  return !!state && state.es.readyState !== EventSource.CLOSED;
}
