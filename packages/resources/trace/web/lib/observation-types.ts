/**
 * Trace 面板的视图模型（前端侧独立转换层）。
 *
 * 上游（Langfuse 兼容实现）的 v2 响应是「宽松记录 + 字段组」形状：字段随 `fields` 查询参数变化、可空性随
 * 版本变化。组件不应该直接消费它——`providerModelName` / `usageDetails` 这类上游命名一旦渗进渲染层，
 * 上游换版本就会以「面板某列突然空掉」的形式出现。因此这里定义面板自己的类型，转换在
 * `./observation-adapter.ts` 一处完成（与后端 `src/server/schemas/traces.ts` 的协议白名单是两层不同
 * 的收敛：那里决定「哪些字段可以出网」，这里决定「面板如何消费」）。
 *
 * 字段取值口径见转换器注释；`latency` / `timeToFirstToken` 由上游直接给出（秒），缺失为 null。
 */
export interface TraceObservation {
  id: string;
  traceId: string | null;
  parentObservationId: string | null;
  /** 上游类型名（`SPAN` / `GENERATION` / `TOOL` / `AGENT` / `EVENT` …）；未知值原样保留。 */
  type: string;
  name: string | null;
  /** ISO 字符串；图布局按 `Date.parse` 排序，解析失败按起始时间兜底。 */
  startTime: string;
  endTime: string | null;
  completionStartTime: string | null;
  level: string | null;
  statusMessage: string | null;
  environment: string | null;
  /** 仅详情请求携带（列表刻意不搬 IO，见后端 `OBSERVATION_SUMMARY_FIELDS`）。 */
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
  /** 模型名（上游 `providedModelName`）。 */
  model: string | null;
  modelId: string | null;
  modelParameters?: unknown;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageDetails: Record<string, number>;
  costDetails: Record<string, number>;
  /** 上游 `totalCost`（美元）；缺失为 null。 */
  totalCost: number | null;
  /** 上游给出的耗时（秒）；缺失为 null。 */
  latency: number | null;
  promptName: string | null;
  promptVersion: number | null;
  tags: string[];
  release: string | null;
  traceName: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** observation 的类型名谓词：图上把生成与工具调用画成事件点，其余类型只做桥接。 */
export type ObservationKind = "generation" | "tool" | "other";

/** 按上游 type 归类；布局与角标共用同一判据。 */
export function observationKind(type: string): ObservationKind {
  if (type === "GENERATION") return "generation";
  if (type === "TOOL") return "tool";
  return "other";
}
