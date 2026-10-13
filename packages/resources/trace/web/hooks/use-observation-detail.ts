import { isAbortError, useRequestSignal } from "@fenix/web-runtime/hooks/use-request-signal";
import { useRequest } from "ahooks";
import { getTraceObservation, type TraceScope } from "../api/traces";
import type { TraceObservation } from "../lib/observation-types";

/**
 * 读取单条 observation 的完整数据（含 IO 与 metadata）。
 *
 * 列表接口刻意不搬 IO（工具输出可能很大），因此**必须**在点开节点时单独取一次：这一步是详情面板数据完整性
 * 的唯一来源，不能被省略成「用列表里的摘要凑合」。`observationId` 为 null 时不发请求。
 */
export function useObservationDetail(
  scope: TraceScope,
  traceId: string | null,
  observationId: string | null,
): { observation: TraceObservation | null; loading: boolean; error: unknown; refresh: () => void } {
  const nextSignal = useRequestSignal();

  const request = useRequest(
    async (): Promise<TraceObservation | null> => {
      const id = observationId;
      const trace = traceId;
      if (!id || !trace) return null;
      return getTraceObservation(scope, trace, id, nextSignal());
    },
    {
      refreshDeps: [scope.environmentId, scope.sessionId, traceId, observationId],
      ready: Boolean(traceId) && Boolean(observationId),
      onError: (error) => {
        if (!isAbortError(error)) console.warn("[trace] 加载 observation 详情失败", error);
      },
    },
  );

  return {
    observation: request.data ?? null,
    loading: request.loading,
    error: isAbortError(request.error) ? undefined : request.error,
    refresh: request.refresh,
  };
}
