import Elysia from "elysia";
import { v4 as uuid } from "uuid";
import { authGuardPlugin } from "../../plugins/auth";
import { requireTeamScope } from "../../plugins/require-team-scope";
import { environmentRepo, sessionRepo, sessionWorkerRepo } from "../../repositories";
import { type UpdateWorkerRequest, UpdateWorkerRequestSchema } from "../../schemas/v2-worker.schema";
import { automationStatesEqual, getAutomationStateEventPayload } from "../../services/automationState";
import { eventService } from "../../services/event-service";
import { getSession, updateSessionStatus } from "../../services/session";

const app = new Elysia({ name: "v1-code-sessions-worker", prefix: "/v1/code/sessions" })
  .use(authGuardPlugin)
  .model({ "update-worker-request": UpdateWorkerRequestSchema });

/** GET /v1/code/sessions/:id/worker — Read worker state */
app.get(
  "/:id/worker",
  async ({ params, error }) => {
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
  { sessionIngressAuth: true },
);

/** PUT /v1/code/sessions/:id/worker — Update worker state */
app.put(
  "/:id/worker",
  async ({ params, body, error }) => {
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
  { sessionIngressAuth: true, body: "update-worker-request" },
);

/** POST /v1/code/sessions/:id/worker/heartbeat — Keep worker alive */
app.post(
  "/:id/worker/heartbeat",
  async ({ params, error }) => {
    const sessionId = params.id;
    const session = await getSession(sessionId);
    if (!session) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }

    const now = new Date();
    await sessionWorkerRepo.upsert(sessionId, { lastHeartbeatAt: now });
    return { status: "ok", last_heartbeat_at: now.toISOString() };
  },
  { sessionIngressAuth: true },
);

/** POST /v1/code/sessions/:id/worker/register — Register worker */
app.post(
  "/:id/worker/register",
  async ({ store, params, error }) => {
    const authContext = store.authContext;
    if (!authContext) {
      return error(403, { error: { type: "forbidden", message: "No team context" } });
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
        const denied = requireTeamScope(authContext, env.teamId);
        if (denied) return denied;
      }
    }

    return { status: "ok" };
  },
  { apiKeyAuth: true },
);

export default app;
