import { log } from "@fenix/logger";
import Elysia from "elysia";
import * as z from "zod/v4";
import { authGuardPlugin } from "../../plugins/auth";
import { environmentRepo, sessionRepo } from "../../repositories";
import { WebErrSchema, WebOkSchema } from "../../schemas/common.schema";
import { SendEventResponseSchema, SessionEventPayloadSchema } from "../../schemas/session.schema";
import { eventService } from "../../services/event-service";
import { getSession, resolveExistingSessionId, updateSessionStatus } from "../../services/session";
import { publishSessionEvent } from "../../services/transport";

const app = new Elysia({ name: "web-control" }).use(authGuardPlugin).model({
  "send-event-response": SendEventResponseSchema,
  "session-event-payload": SessionEventPayloadSchema,
});

type OwnershipCheckResult =
  | { error: true; response: Response }
  | { error: false; session: NonNullable<Awaited<ReturnType<typeof getSession>>>; sessionId: string };

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
  const resolvedSessionId = await resolveExistingSessionId(sessionId);
  if (!resolvedSessionId) {
    return {
      error: true,
      response: errorFn(404, { success: false, error: { code: "not_found", message: "Session not found" } }),
    };
  }
  // 验证 session 所属环境属于当前组织
  const session = await sessionRepo.getById(resolvedSessionId);
  if (!session) {
    return {
      error: true,
      response: errorFn(404, { success: false, error: { code: "not_found", message: "Session not found" } }),
    };
  }
  if (session.environmentId) {
    const env = await environmentRepo.getById(session.environmentId);
    if (env?.organizationId && env.organizationId !== orgId) {
      return {
        error: true,
        response: errorFn(403, {
          success: false,
          error: { code: "forbidden", message: "Not your organization's session" },
        }),
      };
    }
  }
  const activeSession = await getSession(resolvedSessionId);
  if (!activeSession) {
    return {
      error: true,
      response: errorFn(404, { success: false, error: { code: "not_found", message: "Session not active" } }),
    };
  }
  return { error: false, session: activeSession, sessionId: resolvedSessionId };
}

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
    `[RC-DEBUG] web -> server: published outbound event id=${event.id} type=${event.type} direction=${event.direction} subscribers=${eventService.getBus(sessionId).subscriberCount()}`,
  );
  return { status: "ok" as const, event };
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
  return { status: "ok" as const, event };
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
  await updateSessionStatus(sessionId, "idle");
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

export default app;
