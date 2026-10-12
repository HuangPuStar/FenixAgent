import type { LangfuseConnection } from "../config";

/**
 * Langfuse 兼容后端（Peri-Fuse）的**只读**薄客户端。
 *
 * 为什么是薄层而不是官方 `langfuse` SDK：本模块只消费两个公开读端点（`/api/public/traces`、
 * `/api/public/v2/observations`），官方 SDK 是 OpenAPI 生成的全量客户端，会为两个端点引入一整包依赖与
 * 其分页/重试语义；而服务端契约的真实权威是**部署里的兼容实现**（`docker/peri-fuse`），薄层能把它实际
 * 支持的参数逐字对上，且失败语义由本模块自己掌握。
 *
 * 三条不变式：
 * 1. **密钥不出服务端**：Basic 凭据只在请求头里组装，永不进入日志、错误消息或响应（{@link describeFailure}
 *    只回报状态码与路径，不回报请求头与响应体）。
 * 2. **不代理任意路径**：只有本文件列出的具名方法能发起请求，参数经类型收窄后拼装，调用方无法把浏览器
 *    传来的字符串当 URL 用。
 * 3. **失败不静默**：网络/超时、鉴权、上游 5xx 与响应形状异常都抛 {@link LangfuseReadError}，由路由映射
 *    成显式的 `/web` 错误体；不吞错、不返回空数组冒充「没有数据」。
 */

/** 只读失败的分类：路由据此选出对外错误码，且不泄漏上游细节。 */
export type LangfuseFailureKind =
  /** 连接、DNS、超时等「够不到上游」。 */
  | "unreachable"
  /** 上游 401/403：部署凭据无效或未授权（消息里不出现任何密钥材料）。 */
  | "unauthorized"
  /** 上游 404：目标 trace / observation 不存在。 */
  | "not_found"
  /** 上游其它非 2xx。 */
  | "upstream"
  /** 上游 2xx 但响应不是预期的 JSON 形状。 */
  | "invalid_response";

/** Langfuse 读取失败。模块内错误类型：跨协议边界时由路由映射成 `/web` 错误体。 */
export class LangfuseReadError extends Error {
  constructor(
    readonly kind: LangfuseFailureKind,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LangfuseReadError";
  }
}

/** 默认超时：观测读取是交互式路径，上游卡住时要尽快让面板进入可重试的错误态。 */
const DEFAULT_TIMEOUT_MS = 8_000;

/** 单次请求可接受的响应体上限（字节）；观测图整体受 limit 约束，这里只是兜底防呆。 */
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

/** trace 列表查询参数（已由路由收窄，此处不再接受任意透传）。 */
export interface LangfuseTraceListParams {
  readonly sessionId: string;
  readonly limit: number;
  readonly page: number;
}

/** observation 游标分页查询参数。 */
export interface LangfuseObservationListParams {
  /** 按 trace 过滤（trace 归属校验已在上层完成）。 */
  readonly traceId: string;
  readonly limit: number;
  readonly cursor?: string;
  /** 字段组；由调用方显式给出，不用上游默认值（默认值会把 IO 一并拖回来）。 */
  readonly fields: string;
  /** 元数据展开键：`*` 表示全部不截断。 */
  readonly expandMetadata?: string;
  /** 结构化过滤条件（仅用于「按 id 取单条」这类收敛查询）。 */
  readonly filter?: readonly LangfuseFilterCondition[];
}

/** 结构化过滤条件（与 Langfuse public API 的 `filter` 参数同形）。 */
export interface LangfuseFilterCondition {
  readonly type: "string";
  readonly column: string;
  readonly operator: "=";
  readonly value: string;
}

/** 上游游标分页响应。 */
export interface LangfuseCursorPage<T> {
  readonly data: T[];
  readonly meta: { readonly cursor?: string | null };
}

/** 上游 trace 列表响应。 */
export interface LangfuseTracePage<T> {
  readonly data: T[];
  readonly meta: {
    readonly page: number;
    readonly limit: number;
    readonly totalItems: number;
    readonly totalPages: number;
  };
}

/** 只读薄客户端。 */
export interface LangfuseClient {
  /** `GET /api/public/traces?sessionId=…`（按会话列 run）。 */
  listTraces<T>(params: LangfuseTraceListParams, signal?: AbortSignal): Promise<LangfuseTracePage<T>>;
  /** `GET /api/public/traces/:traceId`（归属校验与详情共用）。 */
  getTrace<T>(traceId: string, fields: string, signal?: AbortSignal): Promise<T>;
  /** `GET /api/public/v2/observations`（游标分页 / 按 id 取单条）。 */
  listObservations<T>(params: LangfuseObservationListParams, signal?: AbortSignal): Promise<LangfuseCursorPage<T>>;
}

/** 归一化基址：容忍部署写成 `http://host:23332/` 这种带尾斜杠的形式。 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** 拼装**路径 + 查询**（相对形式）：基址只在一个地方拼接，避免出现第二份 URL 组装逻辑。 */
function buildPath(path: string, query: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}

/** 上游失败的人读描述：只带状态码与路径，绝不带请求头、凭据或响应体。 */
function describeFailure(kind: LangfuseFailureKind, path: string, status?: number): string {
  if (kind === "unreachable") return `Langfuse 后端不可达（${path}）`;
  if (kind === "unauthorized") return `Langfuse 拒绝了读取请求（${path}，HTTP ${status}）：检查部署凭据`;
  if (kind === "not_found") return `Langfuse 中不存在该记录（${path}）`;
  return `Langfuse 读取失败（${path}，HTTP ${status}）`;
}

/** 分类上游状态码：鉴权与「不存在」要分开，面板对两者的处置完全不同。 */
function classifyStatus(status: number): LangfuseFailureKind {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  return "upstream";
}

/** 把外部中断与超时信号合并成上游请求的 signal（任一触发即放弃）。 */
function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * 创建只读薄客户端。
 *
 * 不缓存、不重试：读路径的失败要如实到达面板（重试由用户手势触发）。静默重试会把一次上游故障放大成
 * 多次无谓请求，也会让「点了没反应」无从诊断。
 */
export function createLangfuseClient(
  connection: LangfuseConnection,
  options: { readonly timeoutMs?: number } = {},
): LangfuseClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const origin = normalizeBaseUrl(connection.baseUrl);
  const authorization = `Basic ${Buffer.from(`${connection.publicKey}:${connection.secretKey}`).toString("base64")}`;

  async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${origin}${path}`, {
        method: "GET",
        headers: { authorization, accept: "application/json" },
        signal: combineSignals(signal, timeoutMs),
      });
    } catch (cause) {
      // 超时与连接失败同一处置：面板的重试手势是唯一重试入口。`cause` 只随服务端日志用于诊断。
      throw new LangfuseReadError("unreachable", describeFailure("unreachable", path), undefined, { cause });
    }
    if (!response.ok) {
      const kind = classifyStatus(response.status);
      throw new LangfuseReadError(kind, describeFailure(kind, path, response.status), response.status);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new LangfuseReadError("invalid_response", `Langfuse 响应过大（${path}）`);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new LangfuseReadError("invalid_response", `Langfuse 响应不是合法 JSON（${path}）`);
    }
  }

  return {
    listTraces<T>(params: LangfuseTraceListParams, signal?: AbortSignal) {
      return requestJson<LangfuseTracePage<T>>(
        buildPath("/api/public/traces", {
          sessionId: params.sessionId,
          limit: params.limit,
          page: params.page,
          fields: "core,metrics",
        }),
        signal,
      );
    },
    getTrace<T>(traceId: string, fields: string, signal?: AbortSignal) {
      return requestJson<T>(buildPath(`/api/public/traces/${encodeURIComponent(traceId)}`, { fields }), signal);
    },
    listObservations<T>(params: LangfuseObservationListParams, signal?: AbortSignal) {
      return requestJson<LangfuseCursorPage<T>>(
        buildPath("/api/public/v2/observations", {
          traceId: params.traceId,
          limit: params.limit,
          cursor: params.cursor,
          fields: params.fields,
          expandMetadata: params.expandMetadata,
          filter: params.filter ? JSON.stringify(params.filter) : undefined,
        }),
        signal,
      );
    },
  };
}
