import { isAbortError, useRequestSignal } from "@fenix/web-runtime/hooks/use-request-signal";
import { useRequest } from "ahooks";
import { listSessionTraces, type TraceListResponse, type TraceScope } from "../api/traces";

/** 单页拉取条数：与后端上限一致（`TraceListQuerySchema` 的 limit ≤ 100）。 */
const PAGE_SIZE = 100;
/** 自动翻页上限：防止上游分页信息异常时无限请求；到顶后由面板提示「还有更多」。 */
const MAX_PAGES = 5;

/**
 * 列出当前实例的 run（= 会话下的 trace）。
 *
 * 面板要「列举这个会话的所有 run」，所以这里自动翻页到取完（或到 {@link MAX_PAGES}）；`totalItems` 依旧
 * 上报，列表底部据此提示尚未加载的条数。会话尚未建立 ACP 会话时后端返回 `acpSessionId: null` 与空列表，
 * 这不是错误（面板展示引导态，与「加载失败」严格分开）。
 */
export function useSessionTraces(scope: TraceScope, enabled = true) {
  const nextSignal = useRequestSignal();

  const request = useRequest(
    async (): Promise<TraceListResponse> => {
      const signal = nextSignal();
      const first = await listSessionTraces(scope, { page: 1, limit: PAGE_SIZE }, signal);
      if (!first.configured || first.traces.length >= first.totalItems) return first;

      const traces = [...first.traces];
      const pages = Math.min(Math.ceil(first.totalItems / PAGE_SIZE), MAX_PAGES);
      for (let page = 2; page <= pages; page++) {
        const next = await listSessionTraces(scope, { page, limit: PAGE_SIZE }, signal);
        traces.push(...next.traces);
        if (next.traces.length === 0) break;
      }
      return { ...first, traces };
    },
    {
      refreshDeps: [scope.environmentId, scope.sessionId],
      ready: enabled && Boolean(scope.environmentId) && Boolean(scope.sessionId),
      onError: (error) => {
        if (!isAbortError(error)) console.warn("[trace] 加载 run 列表失败", error);
      },
    },
  );

  return {
    data: request.data ?? null,
    loading: request.loading,
    error: isAbortError(request.error) ? undefined : request.error,
    refresh: request.refresh,
  };
}
