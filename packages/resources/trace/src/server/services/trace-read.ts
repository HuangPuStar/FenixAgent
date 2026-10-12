import { NotFoundError } from "@fenix/platform-sdk";
import type { LangfuseConnection } from "../config";
import type {
  ObservationPageResponse,
  ObservationResponse,
  TraceListResponse,
  TraceObservation,
  TraceSummary,
} from "../schemas/traces";
import { OBSERVATION_ALLOWED_KEYS, TraceObservationSchema } from "../schemas/traces";
import type { LangfuseClient } from "./langfuse-client";
import { LangfuseReadError } from "./langfuse-client";

/**
 * Trace 观测的读取服务：会话解析 → 归属校验 → 上游取数 → 协议整形。
 *
 * 三条边界逐条对应一个安全不变量：
 * 1. **查谁由 Doc 决定**：Langfuse 的 `sessionId` 过滤条件来自 Session Doc 的活跃 ACP session id，浏览器
 *    只提供「哪个 environment + 哪个实例」；它无法构造出属于别人的过滤条件。
 * 2. **trace 必须属于该会话**：所有按 traceId 的读取都先取一次 trace 的 `sessionId` 并与会话比对，不一致按
 *    404 处理（与 `peri-task-details` 同口径：不区分「不存在」与「不属于你」，避免把归属探针变成枚举接口）。
 * 3. **字段白名单**：上游行经 {@link OBSERVATION_ALLOWED_KEYS} 收敛后才出网，兼容实现的新增字段默认不外泄。
 *
 * 依赖以端口形式注入（`resolveActiveAcpSessionId` / `resolveConnection` / `createClient`）：包内测试要能
 * 在没有 DocManager、没有 Langfuse 后端的情况下覆盖上面三条边界。
 */

/** 服务端口：生产实现在 `trace-session.ts` 与 `config.ts`，测试可整组替换。 */
export interface TraceReadPorts {
  readonly resolveActiveAcpSessionId: (rcsSessionId: string) => string | null;
  readonly resolveConnection: () => LangfuseConnection | null;
  readonly createClient: (connection: LangfuseConnection) => LangfuseClient;
}

/** 读取入参：`rcsSessionId` 已由路由按认证主体算出，traceId / cursor 仍属外部输入。 */
export interface TraceReadInput {
  readonly rcsSessionId: string;
  readonly traceId: string;
}

/** observation 摘要字段组：与上游 `fields` 参数同义（core/basic 恒在，故不列出）。 */
export const OBSERVATION_SUMMARY_FIELDS = "time,model,usage,prompt,metrics,metadata";
/** observation 详情字段组：在摘要之上补 IO（面板点开节点才取，避免列表阶段搬运工具输出）。 */
export const OBSERVATION_DETAIL_FIELDS = `${OBSERVATION_SUMMARY_FIELDS},io`;

/** Trace 观测读取服务。 */
export interface TraceReadService {
  /** 列出当前会话的 run（trace）；未配置观测读取时返回 `configured: false`。 */
  listSessionTraces(
    input: { rcsSessionId: string; page: number; limit: number },
    signal?: AbortSignal,
  ): Promise<TraceListResponse>;
  /** 列出某条 run 的 observations（游标分页）。 */
  listTraceObservations(
    input: TraceReadInput & { cursor?: string; limit: number },
    signal?: AbortSignal,
  ): Promise<ObservationPageResponse>;
  /** 读取单条 observation（含 IO）；供面板节点详情使用。 */
  getTraceObservation(
    input: TraceReadInput & { observationId: string },
    signal?: AbortSignal,
  ): Promise<ObservationResponse>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** 上游行 → 列表项；上游缺字段一律降级为 null，不让面板因一个可选字段缺失而整体失败。 */
function toTraceSummary(row: Record<string, unknown>): TraceSummary {
  const timestamp = row.timestamp;
  return {
    id: readString(row.id) ?? "",
    name: readString(row.name),
    timestamp: timestamp instanceof Date ? timestamp.toISOString() : (readString(timestamp) ?? null),
    sessionId: readString(row.sessionId),
    userId: readString(row.userId),
    version: readString(row.version),
    release: readString(row.release),
    environment: readString(row.environment),
    bookmarked: row.bookmarked === true,
    tags: readStringArray(row.tags),
  };
}

/** 上游行 → 白名单对象：未登记的键（`projectId`、`*Price` 等）在这里被丢弃。 */
function pickAllowedKeys(row: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set<string>(OBSERVATION_ALLOWED_KEYS);
  const picked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!allowed.has(key)) continue;
    picked[key] = value instanceof Date ? value.toISOString() : value;
  }
  return picked;
}

/**
 * 上游行 → 协议 observation；缺少渲染必需字段（`id` / `type` / `startTime`）的行返回 null。
 *
 * 走 schema 校验而不是逐字段断言：对外契约的强约束就写在 {@link TraceObservationSchema} 里，这里复用同一份
 * 判据，两处不会漂移。列表按「跳过该行」处理——一个畸形节点不该让整张图取不回来。
 */
function toObservation(row: Record<string, unknown>): TraceObservation | null {
  const parsed = TraceObservationSchema.safeParse(pickAllowedKeys(row));
  return parsed.success ? parsed.data : null;
}

/** 一次「连接是否可用」的判定结果：未配置时后续步骤一律不执行。 */
function connectionOf(ports: TraceReadPorts): LangfuseConnection | null {
  return ports.resolveConnection();
}

/**
 * 创建读取服务。
 *
 * 每次请求按当前部署配置新建客户端（配置为启动期投影、进程内不变，构造成本只是字符串拼接），因此没有
 * 跨请求缓存，也不存在「换了部署仍用旧凭据」的窗口。
 */
export function createTraceReadService(ports: TraceReadPorts): TraceReadService {
  /** 归属校验：返回该 trace（已确认属于本会话）；不属于或不存在一律 404。 */
  async function assertTraceInSession(
    client: LangfuseClient,
    traceId: string,
    acpSessionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const trace = await client.getTrace<Record<string, unknown>>(traceId, "core", signal);
    if (readString(trace?.sessionId) !== acpSessionId) throw new NotFoundError("Trace 不存在");
  }

  return {
    async listSessionTraces({ rcsSessionId, page, limit }, signal) {
      const connection = connectionOf(ports);
      if (!connection) {
        return { configured: false, acpSessionId: null, traces: [], page: 1, totalItems: 0 };
      }
      const acpSessionId = ports.resolveActiveAcpSessionId(rcsSessionId);
      if (!acpSessionId) {
        // 「已配置观测，但这个实例还没有建立过 ACP 会话」——与未配置区分，前端提示语不同。
        return { configured: true, acpSessionId: null, traces: [], page: 1, totalItems: 0 };
      }
      const client = ports.createClient(connection);
      const result = await client.listTraces<Record<string, unknown>>({ sessionId: acpSessionId, page, limit }, signal);
      return {
        configured: true,
        acpSessionId,
        traces: result.data.map(toTraceSummary).filter((trace) => trace.id.length > 0),
        page: result.meta.page,
        totalItems: result.meta.totalItems,
      };
    },

    async listTraceObservations({ rcsSessionId, traceId, cursor, limit }, signal) {
      const connection = connectionOf(ports);
      if (!connection) return { data: [], cursor: null };
      const acpSessionId = ports.resolveActiveAcpSessionId(rcsSessionId);
      if (!acpSessionId) throw new NotFoundError("Trace 不存在");
      const client = ports.createClient(connection);
      await assertTraceInSession(client, traceId, acpSessionId, signal);
      const page = await client.listObservations<Record<string, unknown>>(
        { traceId, limit, cursor, fields: OBSERVATION_SUMMARY_FIELDS, expandMetadata: "*" },
        signal,
      );
      return {
        data: page.data
          .map(toObservation)
          .filter((observation): observation is TraceObservation => observation !== null),
        cursor: readString(page.meta?.cursor),
      };
    },

    async getTraceObservation({ rcsSessionId, traceId, observationId }, signal) {
      const connection = connectionOf(ports);
      if (!connection) throw new NotFoundError("Observation 不存在");
      const acpSessionId = ports.resolveActiveAcpSessionId(rcsSessionId);
      if (!acpSessionId) throw new NotFoundError("Observation 不存在");
      const client = ports.createClient(connection);
      await assertTraceInSession(client, traceId, acpSessionId, signal);
      // traceId 一并进过滤条件：即使上游 id 全局唯一，也不让「拿别人的 observation id 试探」成为可能。
      const page = await client.listObservations<Record<string, unknown>>(
        {
          traceId,
          limit: 1,
          fields: OBSERVATION_DETAIL_FIELDS,
          expandMetadata: "*",
          filter: [
            { type: "string", column: "id", operator: "=", value: observationId },
            { type: "string", column: "traceId", operator: "=", value: traceId },
          ],
        },
        signal,
      );
      const row = page.data[0];
      if (!row) throw new NotFoundError("Observation 不存在");
      const observation = toObservation(row);
      // 单条读取里畸形响应不是「不存在」：上游违反了它自己的契约，按上游故障上报，别把它藏进 404。
      if (!observation) throw new LangfuseReadError("invalid_response", "Langfuse 返回的 observation 缺少必需字段");
      return { data: observation };
    },
  };
}
