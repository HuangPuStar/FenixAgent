import Elysia from "elysia";
import { v4 as uuid } from "uuid";
import { authGuardPlugin } from "../../plugins/auth";
import { requireOrgScope } from "../../plugins/require-team-scope";
import { environmentRepo, sessionRepo, sessionWorkerRepo } from "../../repositories";
import {
  CodeSessionIdParamsSchema,
  GetWorkerResponseSchema,
  StatusOkResponseSchema,
  type UpdateWorkerRequest,
  UpdateWorkerRequestSchema,
  UpdateWorkerResponseSchema,
  WorkerHeartbeatResponseSchema,
  WorkerRegisterResponseSchema,
} from "../../schemas";
import { automationStatesEqual, getAutomationStateEventPayload } from "../../services/automationState";
import { eventService } from "../../services/event-service";
import { getSession, updateSessionStatus } from "../../services/session";

const app = new Elysia({ name: "v1-code-sessions-worker", prefix: "/v1/code/sessions" }).use(authGuardPlugin).model({
  "code-session-id-params": CodeSessionIdParamsSchema,
  "update-worker-request": UpdateWorkerRequestSchema,
  "get-worker-response": GetWorkerResponseSchema,
  "update-worker-response": UpdateWorkerResponseSchema,
  "worker-heartbeat-response": WorkerHeartbeatResponseSchema,
  "worker-register-response": WorkerRegisterResponseSchema,
  "status-ok-response": StatusOkResponseSchema,
});

/** GET /v1/code/sessions/:id/worker — Read worker state */
app.get(
  "/:id/worker",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ params, error }: any) => {
    const sessionId = params.id;
    const session = await getSession(sessionId);
    if (!session) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }

    const worker = await sessionWorkerRepo.get(sessionId);
    return {
      worker: {
        worker_status: worker?.workerStatus ?? session.status,
        external_metadata: worker?.externalMetadata ?? null,
        requires_action_details: worker?.requiresActionDetails ?? null,
        last_heartbeat_at: worker?.lastHeartbeatAt?.toISOString() ?? null,
      },
    };
  },
  {
    sessionIngressAuth: true,
    params: "code-session-id-params",
    response: "get-worker-response",
    detail: {
      tags: ["Code Session"],
      summary: "读取 Worker 状态",
      description: "返回指定 Code Session 当前关联的 worker 状态、外部元数据和最近心跳时间。",
    },
  },
);

/** PUT /v1/code/sessions/:id/worker — Update worker state */
app.put(
  "/:id/worker",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ params, body, error }: any) => {
    const sessionId = params.id;
    const session = await getSession(sessionId);
    if (!session) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }

    const b = body as UpdateWorkerRequest;
    const prevAutomationState = getAutomationStateEventPayload(
      (await sessionWorkerRepo.get(sessionId))?.externalMetadata,
    );
    if (b.worker_status) {
      await updateSessionStatus(sessionId, b.worker_status);
    }

    const worker = await sessionWorkerRepo.upsert(sessionId, {
      workerStatus: b.worker_status,
      externalMetadata: b.external_metadata,
      requiresActionDetails: b.requires_action_details,
    });
    const nextAutomationState = getAutomationStateEventPayload(worker.externalMetadata);

    if (!automationStatesEqual(prevAutomationState, nextAutomationState)) {
      eventService.publishEvent(sessionId, {
        id: uuid(),
        sessionId,
        type: "automation_state",
        payload: nextAutomationState,
        direction: "inbound",
      });
    }

    return {
      status: "ok",
      worker: {
        worker_status: worker.workerStatus ?? session.status,
        external_metadata: worker.externalMetadata,
        requires_action_details: worker.requiresActionDetails,
        last_heartbeat_at: worker.lastHeartbeatAt?.toISOString() ?? null,
      },
    };
  },
  {
    sessionIngressAuth: true,
    params: "code-session-id-params",
    body: "update-worker-request",
    response: "update-worker-response",
    detail: {
      tags: ["Code Session"],
      summary: "更新 Worker 状态",
      description: "更新 worker 状态、外部元数据和待处理详情；必要时会发出自动化状态变更事件。",
    },
  },
);

/** POST /v1/code/sessions/:id/worker/heartbeat — Keep worker alive */
app.post(
  "/:id/worker/heartbeat",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ params, error }: any) => {
    const sessionId = params.id;
    const session = await getSession(sessionId);
    if (!session) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }

    const now = new Date();
    await sessionWorkerRepo.upsert(sessionId, { lastHeartbeatAt: now });
    return { status: "ok", last_heartbeat_at: now.toISOString() };
  },
  {
    sessionIngressAuth: true,
    params: "code-session-id-params",
    response: "worker-heartbeat-response",
    detail: {
      tags: ["Code Session"],
      summary: "上报 Worker 心跳",
      description: "刷新指定 Code Session 对应 worker 的最近心跳时间。",
    },
  },
);

/** POST /v1/code/sessions/:id/worker/register — Register worker */
app.post(
  "/:id/worker/register",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, params, error }: any) => {
    const authContext = store.authContext;
    if (!authContext) {
      return error(403, { error: { type: "forbidden", message: "No organization context" } });
    }
    const sessionId = params.id;
    const session = await getSession(sessionId);
    if (!session) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }

    // 校验 session 归属
    const sessionRecord = await sessionRepo.getById(sessionId);
    if (sessionRecord?.environmentId) {
      const env = await environmentRepo.getById(sessionRecord.environmentId);
      if (env) {
        const denied = requireOrgScope(authContext, env.organizationId);
        if (denied) return denied;
      }
    }

    return { status: "ok" };
  },
  {
    apiKeyAuth: true,
    params: "code-session-id-params",
    response: "worker-register-response",
    detail: {
      tags: ["Code Session"],
      summary: "注册 Worker",
      description: "校验 worker 对指定 Code Session 的访问归属，并完成注册握手。",
    },
  },
);

export default app;
