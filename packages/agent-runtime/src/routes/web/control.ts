/**
 * 控制面路由工厂：`/web/sessions/:id/{events,control,interrupt}`（1.5c 从宿主
 * `apps/server/src/routes/web/control.ts` 迁入）。
 *
 * 归属：会话事件与状态、实例归属、环境组织归属三件事的 owner 都是本包（`services/session`、
 * `facades/` 下的会话访问门面与环境访问门面），本文件没有任何一处跨领域依赖，因此落点在本包而不是宿主。
 *
 * 与 1.2 改判的关系：该路由在 CE 阶段 2 任务 1.2 曾被判为「必须留在宿主」——当时的理由是它同时依赖
 * Agent Runtime 的会话服务与 Machine 的事件服务，放进任一模块都会与 `resource-machine → agent-runtime`
 * 形成环。1.4 W6b 已把 EventBus 与 `environmentRepo` 收敛回本包（Machine 的同名薄封装删除），那条前提
 * 因此消失；1.5c 按 §四 分片表把它迁入本包，宿主只保留注入守卫后的挂载。
 *
 * 守卫由宿主注入（与 `/api/instances`、`/acp/*` 同因）：Elysia 的 `macro` / `state` 是实例作用域的，
 * 包内自建一份会让同一进程出现两套互不可见的认证状态。
 *
 * 取数方式（C2 收敛时改判）：本文件原先在路由内直引 `environmentRepo`，文件头当时把「包内路由直引实现」
 * 写成惯例（含包内 `routes/web/instances.ts` 中与之配套的判据说明）。该说法与 §3.2「route 不直接访问
 * repository、不自行编排归属判断」冲突，已按规范收敛：会话 → 持久实例 → 环境 → 组织的归属链整体下沉到
 * `facades/session-access-facade`（环境读取在其内的 `facades/environment-access-facade`），本文件只保留
 * 协议校验、认证上下文提取与「门面结论 → 响应」映射。会话事件总线不属运行 port 的能力面，仍按原口径经
 * `session-event-bus-port` 由宿主注入，因此这里不经 `getBoundAgentRuntime()`——后者是**宿主**装配完成的
 * 判据，包内路由走它等于自引用本包入口。
 */

import { log } from "@fenix/logger";
import { WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import * as z from "zod/v4";
import { type SessionAccessDenial, sessionAccessFacade } from "../../facades/session-access-facade";
import { SendEventResponseSchema, SessionEventPayloadSchema } from "../../schemas/session.schema";
import { updateSessionStatus } from "../../services/session";
import { getEventBus, type SessionEvent } from "../../transport/event-bus";
import { publishSessionEvent } from "../../transport/session-events";
import type { AgentRuntimeAuthDependencies } from "../dependencies";

/** 归属校验结果：失败分支直接带响应，成功分支只向调用方暴露已解析的会话标识。 */
type OwnershipCheckResult = { error: true; response: Response } | { error: false; sessionId: string };

/**
 * 门面拒绝结论 → 对外响应。
 *
 * 状态码、错误码与文案与收敛前逐字一致（含两种 403 文案的区分）：跨组织会话与「实例不属于你 / 环境已消失」
 * 在客户端可见行为上要有区别，因此这里不是一张可以随意合并的表。
 */
const ACCESS_DENIAL_RESPONSE: Readonly<Record<SessionAccessDenial, { status: number; code: string; message: string }>> =
  {
    session_not_found: { status: 404, code: "not_found", message: "Session not found" },
    session_not_owned: { status: 403, code: "forbidden", message: "Session does not belong to your organization" },
    environment_foreign_organization: { status: 403, code: "forbidden", message: "Not your organization's session" },
    session_not_active: { status: 404, code: "not_found", message: "Session not active" },
  };

/**
 * 总线事件 → 响应视图。
 *
 * 修复一处既有契约缺陷（迁出时发现，1.5c 记录）：响应 schema 声明的事件时间字段是 `timestamp`
 * （`schemas/session.schema.ts` 的 `SessionEventSchema`），而事件总线产出的是 `createdAt`——两者同名不同义，
 * 导致 `/sessions/:id/events` 与 `/sessions/:id/control` 的**成功路径一直返回 422**（Elysia 响应校验失败，
 * 实测 `{"type":"validation","on":"response","property":"data"}`）。Elysia 会按 schema 剔除未声明字段，
 * 因此这里显式投影，而不是把总线对象整体回传后靠 schema 过滤——落盘的线上形状即 schema 本身。
 *
 * 默认落在 `/web/*`（控制台内部 API），仓内无消费方，因此不存在对外兼容包袱；如审核认为应保留
 * 「422」这一既有行为，回退点是把本函数换成直传 `event` 并同步用例。
 */
function toSessionEventView(event: SessionEvent) {
  return {
    id: event.id,
    sessionId: event.sessionId,
    type: event.type,
    timestamp: event.createdAt,
    payload: event.payload,
  };
}

/**
 * 归属校验：只做「认证上下文是否完整」与「门面结论 → 响应」的映射。
 *
 * 会话 → 持久实例 → 环境 → 组织的逐级回查在 `sessionAccessFacade` 内完成（资源标识是持久 instanceUid，
 * 归属链的每一步都不依赖可伪造的 session ID 编码）；本函数保留的只是协议层判断——认证上下文缺失时按
 * 未认证拒绝，否则把门面的拒绝结论翻成既有响应。
 */
async function checkOwnership(
  userId: string | null,
  orgId: string | null,
  sessionId: string,
  errorFn: (code: number, body: unknown) => Response,
): Promise<OwnershipCheckResult> {
  if (!userId || !orgId) {
    return {
      error: true,
      response: errorFn(403, { success: false, error: { code: "forbidden", message: "Not authenticated" } }),
    };
  }
  const access = await sessionAccessFacade.resolveAccess(sessionId, orgId, userId);
  if (!access.granted) {
    const denial = ACCESS_DENIAL_RESPONSE[access.denial];
    return {
      error: true,
      response: errorFn(denial.status, { success: false, error: { code: denial.code, message: denial.message } }),
    };
  }
  return { error: false, sessionId: access.sessionId };
}

/**
 * 构造 `/web/sessions/:id/*` 控制面路由。
 *
 * 前两条端点把用户事件 / 控制请求发布到该会话的事件总线；`interrupt` 额外把会话状态置为 `idle`。
 */
export function createWebControlRoutes(deps: AgentRuntimeAuthDependencies) {
  const app = new Elysia({ name: "web-control" }).use(deps.authGuardPlugin).model({
    "send-event-response": SendEventResponseSchema,
    "session-event-payload": SessionEventPayloadSchema,
  });

  /** POST /web/sessions/:id/events — Send user message to session */
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  const sendSessionEventHandler: any = async ({ store, params, body, error }: any) => {
    const requestedSessionId = params.id;
    const userId = store.user?.id ?? null;
    const orgId = store.authContext?.organizationId ?? null;
    const ownership = await checkOwnership(userId, orgId, requestedSessionId, error);
    if (ownership.error) {
      return ownership.response;
    }
    const { sessionId } = ownership;

    const b = body as { type?: string; [key: string]: unknown };
    const eventType = b.type || "user";
    log(
      `[RC-DEBUG] web -> server: POST /web/sessions/${sessionId}/events type=${eventType} content=${JSON.stringify(b).slice(0, 200)}`,
    );
    const event = publishSessionEvent(sessionId, eventType, b, "outbound");
    log(
      `[RC-DEBUG] web -> server: published outbound event id=${event.id} type=${event.type} direction=${event.direction} subscribers=${getEventBus(sessionId).subscriberCount()}`,
    );
    return { success: true as const, data: { status: "ok" as const, event: toSessionEventView(event) } };
  };

  app.post("/sessions/:id/events", sendSessionEventHandler, {
    sessionAuth: true,
    body: "session-event-payload",
    response: {
      200: "send-event-response",
      403: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["Control"],
      summary: "发送会话事件",
      description: "向指定会话发送一个用户事件或自定义事件，并返回后端记录下来的事件对象。",
    },
  });

  /** POST /web/sessions/:id/control — Send control request (permission approval etc) */
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  const sendControlEventHandler: any = async ({ store, params, body, error }: any) => {
    const requestedSessionId = params.id;
    const userId = store.user?.id ?? null;
    const orgId = store.authContext?.organizationId ?? null;
    const ownership = await checkOwnership(userId, orgId, requestedSessionId, error);
    if (ownership.error) {
      return ownership.response;
    }
    const { sessionId } = ownership;

    const b = body as { type?: string; [key: string]: unknown };
    const event = publishSessionEvent(sessionId, b.type || "control_request", b, "outbound");
    return { success: true as const, data: { status: "ok" as const, event: toSessionEventView(event) } };
  };

  app.post("/sessions/:id/control", sendControlEventHandler, {
    sessionAuth: true,
    body: "session-event-payload",
    response: {
      200: "send-event-response",
      403: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["Control"],
      summary: "发送控制指令",
      description: "向指定会话发送控制类事件，例如权限响应、恢复执行或其他控制请求。",
    },
  });

  /** POST /web/sessions/:id/interrupt — Interrupt session */
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  const interruptSessionHandler: any = async ({ store, params, error }: any) => {
    const requestedSessionId = params.id;
    const userId = store.user?.id ?? null;
    const orgId = store.authContext?.organizationId ?? null;
    const ownership = await checkOwnership(userId, orgId, requestedSessionId, error);
    if (ownership.error) {
      return ownership.response;
    }
    const { sessionId } = ownership;

    publishSessionEvent(sessionId, "interrupt", { action: "interrupt" }, "outbound");
    updateSessionStatus(sessionId, "idle");
    return { success: true as const, data: null };
  };

  app.post("/sessions/:id/interrupt", interruptSessionHandler, {
    sessionAuth: true,
    response: {
      200: WebOkSchema(z.null().describe("中断成功后固定返回 null。")).describe("中断会话响应。"),
      403: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["Control"],
      summary: "中断会话",
      description: "向指定会话发送中断事件，并将该会话状态更新为 idle。",
    },
  });

  return app;
}
