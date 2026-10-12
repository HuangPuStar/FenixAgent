import { request, unwrap } from "@fenix/web-runtime/api/request";
import { toTraceObservation } from "../lib/observation-adapter";
import type { TraceObservation } from "../lib/observation-types";

/**
 * Trace 面板的取数层：只与本包自己的 `/web/...` 协议说话。
 *
 * 三条接口对应面板的三次取数（列表 → 图 → 节点详情）。浏览器**不接触** Langfuse：基址与凭据都在服务端
 * （见 `src/server/services/langfuse-client.ts`），前端只提供「哪个 environment + 哪个实例 + 哪条 trace」
 * 这类定位信息，`sessionId` 实为前端 URL 的实例 uid，会话归属由服务端从 Session Doc 反查。
 *
 * 出网形状（协议行 → 视图模型）在这里就完成转换：组件拿到的一律是 {@link TraceObservation} /
 * {@link TraceSummary}，上游字段命名不会渗进渲染层。
 */

/** run 列表项（后端 `TraceSummarySchema` 的镜像）。 */
export interface TraceSummary {
  id: string;
  name: string | null;
  timestamp: string | null;
  sessionId: string | null;
  userId: string | null;
  version: string | null;
  release: string | null;
  environment: string | null;
  bookmarked: boolean;
  tags: string[];
}

/** run 列表响应；`configured: false` 表示部署未接观测后端（与「这个会话没有 run」不同）。 */
export interface TraceListResponse {
  configured: boolean;
  /** 当前活跃 ACP 会话 id（= Langfuse sessionId）；null 表示尚未建立 ACP 会话。 */
  acpSessionId: string | null;
  traces: TraceSummary[];
  page: number;
  totalItems: number;
}

/**
 * 面板定位：environment 主键 + 实例 uid（= 前端路由的 sessionId 段）。
 *
 * 用 type alias 而非 `interface`：`request()` 的 `params` 要求 `Record<string, string>`，而 TS 只为类型别名
 * 的对象字面量类型提供隐式索引签名，`interface` 会被拒（写成 interface 会在调用点得到 TS2322）。
 */
export type TraceScope = {
  environmentId: string;
  sessionId: string;
};

/** 按会话列出 run。 */
export function listSessionTraces(
  scope: TraceScope,
  params: { page: number; limit: number },
  signal?: AbortSignal,
): Promise<TraceListResponse> {
  return unwrap(
    request<TraceListResponse>("/web/agents/:environmentId/sessions/:sessionId/traces", {
      params: scope,
      query: { page: params.page, limit: params.limit },
      signal,
    }),
  );
}

/**
 * 列出某条 run 的 observations（游标分页）。
 *
 * `signal` 必传：面板切换 trace 或关闭时要取消上一批请求，否则慢响应会覆盖新图。
 */
export function listTraceObservations(
  scope: TraceScope,
  traceId: string,
  params: { cursor?: string | null; limit: number },
  signal: AbortSignal,
): Promise<{ data: TraceObservation[]; cursor: string | null }> {
  return unwrap(
    request<{ data: Record<string, unknown>[]; cursor: string | null }>(
      "/web/agents/:environmentId/sessions/:sessionId/traces/:traceId/observations",
      {
        params: { ...scope, traceId },
        query: { cursor: params.cursor ?? undefined, limit: params.limit },
        signal,
      },
    ),
  ).then((page) => ({ data: page.data.map(toTraceObservation), cursor: page.cursor }));
}

/** 读取单条 observation（含 IO）；供节点详情使用。 */
export function getTraceObservation(
  scope: TraceScope,
  traceId: string,
  observationId: string,
  signal: AbortSignal,
): Promise<TraceObservation> {
  return unwrap(
    request<{ data: Record<string, unknown> }>(
      "/web/agents/:environmentId/sessions/:sessionId/traces/:traceId/observations/:observationId",
      { params: { ...scope, traceId, observationId }, signal },
    ),
  ).then((response) => toTraceObservation(response.data));
}
