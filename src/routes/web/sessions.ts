import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { environmentRepo } from "../../repositories";
import { sessionRepo } from "../../repositories/session";
import { SessionHistorySchema } from "../../schemas/session.schema";
import { eventService } from "../../services/event-service";
import { loadOrgContext } from "../../services/org-context";

const app = new Elysia({ name: "web-sessions", prefix: "/web" }).use(authGuardPlugin).model({
  "session-history": SessionHistorySchema,
});

/** GET /web/sessions — List sessions for the current team */
app.get(
  "/sessions",
  async ({ store, request }) => {
    const authCtx = (await loadOrgContext(store.user!, request))!;
    // 获取团队所有 environmentId，再过滤 session
    const teamEnvs = await environmentRepo.listByOrganizationId(authCtx.organizationId);
    const teamEnvIds = new Set(teamEnvs.map((e) => e.id));
    const allSessions = await sessionRepo.listAll();
    const rows = allSessions.filter((s) => s.environmentId && teamEnvIds.has(s.environmentId));
    return rows.map((r) => ({
      id: r.id,
      title: r.title ?? null,
      status: r.status,
      environment_id: r.environmentId ?? null,
      agent_name: r.username ?? null,
      source: r.source ?? null,
      created_at: Math.floor(r.createdAt.getTime() / 1000),
      updated_at: Math.floor(r.updatedAt.getTime() / 1000),
    }));
  },
  { sessionAuth: true },
);

/** GET /web/sessions/:id — Get session detail */
app.get(
  "/sessions/:id",
  async ({ store, params, error, request }) => {
    const authCtx = (await loadOrgContext(store.user!, request))!;
    const row = await sessionRepo.getById(params.id);
    if (!row) {
      return error(404, { error: { type: "not_found", message: `Session '${params.id}' not found` } });
    }
    // 验证 session 的 environment 属于当前团队
    if (row.environmentId) {
      const env = await environmentRepo.getById(row.environmentId);
      if (!env || env.organizationId !== authCtx.organizationId) {
        return error(404, { error: { type: "not_found", message: `Session '${params.id}' not found` } });
      }
    }
    return {
      id: row.id,
      title: row.title ?? null,
      status: row.status,
      environment_id: row.environmentId ?? null,
      agent_name: row.username ?? null,
      source: row.source ?? null,
      created_at: Math.floor(row.createdAt.getTime() / 1000),
      updated_at: Math.floor(row.updatedAt.getTime() / 1000),
    };
  },
  { sessionAuth: true },
);

/** GET /web/sessions/:id/history — Session event history (EventBus)
 *  Session 元数据已下沉到 Agent，此处仅保留事件流查询 */
app.get(
  "/sessions/:id/history",
  async ({ store, params, error, request }) => {
    const authCtx = (await loadOrgContext(store.user!, request))!;
    const sessionId = params.id;
    // 验证 session 属于当前团队
    const row = await sessionRepo.getById(sessionId);
    if (!row) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }
    if (row.environmentId) {
      const env = await environmentRepo.getById(row.environmentId);
      if (!env || env.organizationId !== authCtx.organizationId) {
        return error(404, { error: { type: "not_found", message: "Session not found" } });
      }
    }
    const bus = eventService.getBus(sessionId);
    if (!bus) {
      return error(404, { error: { type: "not_found", message: "Session event bus not found" } });
    }
    const events = bus.getEventsSince(0);
    return { events };
  },
  { sessionAuth: true },
);

export default app;
