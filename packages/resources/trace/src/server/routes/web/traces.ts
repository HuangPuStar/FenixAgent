import { createDeterministicRcsSessionId } from "@fenix/chat-channel";
import { NotFoundError, WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { z } from "zod/v4";
import { resolveLangfuseConnection } from "../../config";
import {
  ObservationListQuerySchema,
  ObservationPageResponseSchema,
  ObservationResponseSchema,
  TraceListQuerySchema,
  TraceListResponseSchema,
} from "../../schemas/traces";
import { createLangfuseClient, LangfuseReadError } from "../../services/langfuse-client";
import { createTraceReadService, type TraceReadService } from "../../services/trace-read";
import { traceSessionLookup } from "../../services/trace-session";
import type { WebTraceRouteDependencies } from "../dependencies";
import { buildWebErrorBody } from "./error-body";

/**
 * `/web/agents/:environmentId/sessions/:sessionId/traces*` —— 会话观测（trace / observation）只读路由。
 *
 * 三个端点对应面板的三次取数：
 * 1. 列表：该会话的全部 run；
 * 2. observations：选中一条 run 后的图数据（游标分页）；
 * 3. 单条 observation：点开图上节点后的 IO 详情（列表阶段刻意不搬 IO）。
 *
 * 路径沿用 `peri-task-details` 的会话定位口径：`environmentId` 是 Environment 主键，`sessionId` 是前端 URL
 * 的实例 uid；两者 + 认证主体算出 `rcsSessionId`，**Langfuse 的过滤条件由服务端从 Session Doc 取**，浏览器
 * 无法直接指定查谁。
 *
 * 未配置观测读取时列表返回 `configured: false`（200）：这是「部署没接观测后端」，不是错误，面板据此展示
 * 引导而不是把配置问题伪装成故障。
 */

/** 会话路径参数（列表与 observations 共用）。 */
const TraceSessionParamsSchema = z.object({
  environmentId: z.string().min(1),
  sessionId: z.string().min(1),
});

/** trace 路径参数。 */
const TraceParamsSchema = TraceSessionParamsSchema.extend({ traceId: z.string().min(1) });

/** observation 详情路径参数。 */
const TraceObservationParamsSchema = TraceParamsSchema.extend({ observationId: z.string().min(1) });

/** 读取服务的进程级懒构造：首次请求时读模块配置（模块加载期宿主可能尚未完成基础设施初始化）。 */
let readService: TraceReadService | null = null;

function getReadService(): TraceReadService {
  readService ??= createTraceReadService({
    resolveActiveAcpSessionId: traceSessionLookup.resolveActiveAcpSessionId,
    resolveConnection: () => resolveLangfuseConnection(),
    createClient: (connection) => createLangfuseClient(connection),
  });
  return readService;
}

/**
 * 包内测试用 seam：替换读取服务（传 null 恢复懒构造）。
 *
 * 不上包入口：它是测试夹具而非公共契约，包内用例按相对路径引用本模块即可。替换后不触碰 DocManager 与
 * Langfuse 后端，覆盖的是路由自身的归属校验、错误映射与响应契约。
 */
export function setTraceReadServiceForTests(service: TraceReadService | null): void {
  readService = service;
}

/** 路由错误分支的返回形状（Elysia 的 `error(status, body)` 推导在 response schema 组合下不稳定）。 */
type RouteFailure = { status: number; body: ReturnType<typeof buildWebErrorBody> };

/** 把读取失败映射成 `/web` 错误体；不泄漏上游细节（凭据、响应体、内部路径）。 */
function mapReadFailure(failure: unknown): RouteFailure | null {
  if (failure instanceof NotFoundError) {
    return { status: 404, body: buildWebErrorBody("NOT_FOUND", failure.message) };
  }
  if (!(failure instanceof LangfuseReadError)) return null;
  if (failure.kind === "not_found") {
    return { status: 404, body: buildWebErrorBody("NOT_FOUND", "观测记录不存在") };
  }
  if (failure.kind === "unauthorized") {
    // 凭据问题对调用方只表现为「后端拒绝」：真实原因（哪把 key 无效）留在服务端日志里。
    console.error("[trace] Langfuse 拒绝读取请求：检查 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY", failure.message);
    return { status: 502, body: buildWebErrorBody("TRACE_BACKEND_UNAUTHORIZED", "观测后端拒绝了读取请求") };
  }
  if (failure.kind === "unreachable") {
    return { status: 503, body: buildWebErrorBody("TRACE_BACKEND_UNREACHABLE", "观测后端不可达") };
  }
  return { status: 502, body: buildWebErrorBody("TRACE_BACKEND_ERROR", "观测后端返回异常") };
}

/** 构造会话观测只读路由。 */
export function createWebTraceRoutes(deps: WebTraceRouteDependencies) {
  return new Elysia({ name: "web-trace" })
    .use(deps.authGuardPlugin)
    .model({
      "trace-session-params": TraceSessionParamsSchema,
      "trace-params": TraceParamsSchema,
      "trace-observation-params": TraceObservationParamsSchema,
      "trace-list-query": TraceListQuerySchema,
      "observation-list-query": ObservationListQuerySchema,
    })
    .get(
      "/agents/:environmentId/sessions/:sessionId/traces",
      // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
      async ({ store, params, query, error, request }: any) => {
        try {
          const rcsSessionId = await resolveRcsSessionId(deps, store, params);
          const data = await getReadService().listSessionTraces(
            { rcsSessionId, page: query.page, limit: query.limit },
            request?.signal,
          );
          return { success: true as const, data };
        } catch (failure) {
          const mapped = mapReadFailure(failure);
          if (mapped) return error(mapped.status, mapped.body);
          throw failure;
        }
      },
      {
        sessionAuth: true,
        params: "trace-session-params",
        query: "trace-list-query",
        response: {
          200: WebOkSchema(TraceListResponseSchema),
          404: WebErrSchema,
          502: WebErrSchema,
          503: WebErrSchema,
        },
        detail: {
          tags: ["Trace"],
          summary: "按会话列出观测 run（Langfuse trace）",
          description:
            "会话由认证主体 + environmentId + 实例 uid 决定，Langfuse 过滤条件取自 Session Doc 的活跃 ACP 会话；未配置观测读取时 configured=false。",
        },
      },
    )
    .get(
      "/agents/:environmentId/sessions/:sessionId/traces/:traceId/observations",
      // biome-ignore lint/suspicious/noExplicitAny: 同上
      async ({ store, params, query, error, request }: any) => {
        try {
          const rcsSessionId = await resolveRcsSessionId(deps, store, params);
          const data = await getReadService().listTraceObservations(
            { rcsSessionId, traceId: params.traceId, cursor: query.cursor, limit: query.limit },
            request?.signal,
          );
          return { success: true as const, data };
        } catch (failure) {
          const mapped = mapReadFailure(failure);
          if (mapped) return error(mapped.status, mapped.body);
          throw failure;
        }
      },
      {
        sessionAuth: true,
        params: "trace-params",
        query: "observation-list-query",
        response: {
          200: WebOkSchema(ObservationPageResponseSchema),
          404: WebErrSchema,
          502: WebErrSchema,
          503: WebErrSchema,
        },
        detail: {
          tags: ["Trace"],
          summary: "列出某条 run 的 observations（游标分页）",
          description: "trace 必须属于当前会话，否则一律 404；返回字段经白名单收敛。",
        },
      },
    )
    .get(
      "/agents/:environmentId/sessions/:sessionId/traces/:traceId/observations/:observationId",
      // biome-ignore lint/suspicious/noExplicitAny: 同上
      async ({ store, params, error, request }: any) => {
        try {
          const rcsSessionId = await resolveRcsSessionId(deps, store, params);
          const data = await getReadService().getTraceObservation(
            { rcsSessionId, traceId: params.traceId, observationId: params.observationId },
            request?.signal,
          );
          return { success: true as const, data };
        } catch (failure) {
          const mapped = mapReadFailure(failure);
          if (mapped) return error(mapped.status, mapped.body);
          throw failure;
        }
      },
      {
        sessionAuth: true,
        params: "trace-observation-params",
        response: {
          200: WebOkSchema(ObservationResponseSchema),
          404: WebErrSchema,
          502: WebErrSchema,
          503: WebErrSchema,
        },
        detail: {
          tags: ["Trace"],
          summary: "读取单条 observation（含 input/output）",
          description: "id 与 traceId 同时作为过滤条件，避免跨 trace 的 id 试探。",
        },
      },
    );
}

/**
 * 归属校验 + 会话解析。
 *
 * 两步的顺序不可交换：先证明 environment 属于当前主体，再用该主体算 rcsSessionId——反过来的话，归属校验
 * 失败会落在「算出来的 key 查不到 Doc」上，把越权与「会话不存在」在响应上抹平，排障时无从区分。
 */
async function resolveRcsSessionId(
  deps: WebTraceRouteDependencies,
  store: { authContext?: { organizationId: string }; user?: { id: string } },
  params: { environmentId: string; sessionId: string },
): Promise<string> {
  const userId = store.user?.id ?? "";
  await deps.getOwnedEnvironment(params.environmentId, store.authContext?.organizationId ?? "", userId);
  return createDeterministicRcsSessionId(params.environmentId, userId, params.sessionId);
}
