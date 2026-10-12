import type { TraceObservation } from "./observation-types";

/**
 * 后端协议行 → 面板视图模型（唯一转换点）。
 *
 * 上游 `input` / `output` / `metadata` 可能是**字符串化的 JSON**（SDK 直传时序列化成字符串），也可能是
 * 原生对象。这里统一尝试解析：解析失败原样保留（工具输出的纯文本、prompt 散文都走这条），渲染层因此只需
 * 处理「已是结构」的情况，不必到处写 try/catch。解析被限制在「看起来是 JSON 容器」的字符串上，避免把一段
 * 恰好以 `{` 开头的散文误当 JSON 处理。
 */
function parseJsonIfPossible(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNumberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" && Number.isFinite(entry)) result[key] = entry;
  }
  return result;
}

/**
 * 转换一行协议数据。
 *
 * `id` / `type` / `startTime` 由后端 schema 强约束（缺任一的行已被过滤），此处仍按缺省值兜底，是为了让
 * 转换器对「未来放宽的协议」保持无异常——渲染层能容忍一个字段为空的节点，不能容忍转换抛错让整张图消失。
 */
export function toTraceObservation(row: Record<string, unknown>): TraceObservation {
  const usage = readNumberMap(row.usageDetails);
  const promptTokens = usage.input ?? 0;
  const completionTokens = usage.output ?? 0;
  return {
    id: readString(row.id) ?? "",
    traceId: readString(row.traceId),
    parentObservationId: readString(row.parentObservationId),
    type: readString(row.type) ?? "SPAN",
    name: readString(row.name),
    startTime: readString(row.startTime) ?? "",
    endTime: readString(row.endTime),
    completionStartTime: readString(row.completionStartTime),
    level: readString(row.level),
    statusMessage: readString(row.statusMessage),
    environment: readString(row.environment),
    input: parseJsonIfPossible(row.input),
    output: parseJsonIfPossible(row.output),
    metadata: row.metadata,
    model: readString(row.providedModelName),
    modelId: readString(row.modelId) ?? readString(row.internalModelId),
    modelParameters: row.modelParameters,
    promptTokens,
    completionTokens,
    totalTokens: usage.total ?? promptTokens + completionTokens,
    usageDetails: usage,
    costDetails: readNumberMap(row.costDetails),
    totalCost: readNumber(row.totalCost),
    latency: readNumber(row.latency),
    promptName: readString(row.promptName),
    promptVersion: readNumber(row.promptVersion),
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [],
    release: readString(row.release),
    traceName: readString(row.traceName),
    createdAt: readString(row.createdAt) ?? undefined,
    updatedAt: readString(row.updatedAt) ?? undefined,
  };
}
