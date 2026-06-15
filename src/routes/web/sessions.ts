import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { environmentRepo } from "../../repositories";
import { sessionRepo } from "../../repositories/session";
import { SessionDetailSchema, SessionHistorySchema, SessionListResponseSchema } from "../../schemas/session.schema";
import { eventService } from "../../services/event-service";

const app = new Elysia({ name: "web-sessions" }).use(authGuardPlugin).model({
  "session-detail": SessionDetailSchema,
  "session-history": SessionHistorySchema,
  "session-list": SessionListResponseSchema,
});

/** GET /web/sessions — List sessions for the current team */
app.get(
  "/sessions",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, request: _request }: any) => {
    const authCtx = store.authContext!;
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
  {
    sessionAuth: true,
    response: "session-list",
    detail: {
      tags: ["Sessions"],
      summary: "获取会话列表",
      description: "返回当前组织下所有归属于环境的会话列表。",
    },
  },
);

/** GET /web/sessions/:id — Get session detail */
app.get(
  "/sessions/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, params, error, request: _request }: any) => {
    const authCtx = store.authContext!;
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
  {
    sessionAuth: true,
    response: "session-detail",
    detail: {
      tags: ["Sessions"],
      summary: "获取会话详情",
      description: "根据会话 ID 返回单个会话的详情信息，并校验该会话是否属于当前组织。",
    },
  },
);

/** GET /web/sessions/:id/history — Session event history (EventBus)
 *  Session 元数据已下沉到 Agent，此处仅保留事件流查询 */
app.get(
  "/sessions/:id/history",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, params, error, request: _request }: any) => {
    const authCtx = store.authContext!;
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
  {
    sessionAuth: true,
    response: "session-history",
    detail: {
      tags: ["Sessions"],
      summary: "获取会话事件历史",
      description: "返回指定会话当前已缓存的事件历史，用于会话回放和问题排查。",
    },
  },
);

export default app;
