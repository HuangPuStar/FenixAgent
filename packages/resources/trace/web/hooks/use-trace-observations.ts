import { isAbortError, useRequestSignal } from "@fenix/web-runtime/hooks/use-request-signal";
import { useRequest } from "ahooks";
import { listTraceObservations, type TraceScope } from "../api/traces";
import type { TraceObservation } from "../lib/observation-types";

/** 单页条数：与后端上限一致（`ObservationListQuerySchema` 的 limit ≤ 200）。 */
const PAGE_SIZE = 200;
/** 翻页上限（200 × 8 = 1600 个节点）：一张图超过这个规模已不可读，继续拉只会拖垮面板。 */
const MAX_PAGES = 8;

export interface TraceObservationsState {
  observations: TraceObservation[];
  loading: boolean;
  error: unknown;
  refresh: () => void;
}

/**
 * 读取一条 run 的全部 observations（游标翻页到取完）。
 *
 * 图布局需要**全量**观测才能分配泳道与补全隐藏父节点（参考实现在其注释里也写明「hidden parents can arrive
 * on later pages」），因此这里一次取完再交给布局，不做增量渲染：三四十个节点的图分页渲染只会让连线中途
 * 跳变。
 *
 * `traceId` 为 null 时不发请求（面板还没选中 run）。
 */
export function useTraceObservations(scope: TraceScope, traceId: string | null): TraceObservationsState {
  const nextSignal = useRequestSignal();

  const request = useRequest(
    async (): Promise<TraceObservation[]> => {
      // `ready` 已拦住 null；这里再收窄一次是为了让下面的调用不需要任何类型断言。
      const id = traceId;
      if (!id) return [];
      const signal = nextSignal();
      const collected: TraceObservation[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await listTraceObservations(scope, id, { cursor, limit: PAGE_SIZE }, signal);
        collected.push(...result.data);
        cursor = result.cursor;
        if (!cursor || result.data.length === 0) break;
      }
      return collected;
    },
    {
      refreshDeps: [scope.environmentId, scope.sessionId, traceId],
      ready: Boolean(traceId),
      onError: (error) => {
        if (!isAbortError(error)) console.warn("[trace] 加载调用图失败", error);
      },
    },
  );

  return {
    observations: request.data ?? [],
    loading: request.loading,
    error: isAbortError(request.error) ? undefined : request.error,
    refresh: request.refresh,
  };
}
