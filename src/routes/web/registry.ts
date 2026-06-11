import { createLogger } from "@fenix/logger";
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import {
  EventQuerySchema,
  MachineDetailResponseSchema,
  MachineListResponseSchema,
  MachineQuerySchema,
  RegistryEventListResponseSchema,
} from "../../schemas/registry.schema";
import { getMachine, listEvents, listMachines } from "../../services/registry";

const logger = createLogger("registry");

/**
 * 将 Date 转为秒级 Unix 时间戳；null/undefined 原样透传。
 * DB 层返回的是 Date 对象，但响应 schema 要求 number（秒级时间戳）。
 */
function toUnixSeconds(value: Date | null | undefined): number | null {
  if (!value) return null;
  return Math.floor(value.getTime() / 1000);
}

/**
 * 序列化机器记录：把所有 Date 字段转为秒级时间戳，匹配响应 schema。
 */
function serializeMachine<T extends Record<string, unknown>>(row: T): T {
  return {
    ...row,
    lastHeartbeatAt: toUnixSeconds(row.lastHeartbeatAt as Date | null | undefined),
    registeredAt: toUnixSeconds(row.registeredAt as Date | null | undefined),
    createdAt: toUnixSeconds(row.createdAt as Date | null | undefined),
    updatedAt: toUnixSeconds(row.updatedAt as Date | null | undefined),
  } as T;
}

/**
 * 序列化事件记录：把 createdAt 从 Date 转为秒级时间戳。
 */
function serializeEvent<T extends Record<string, unknown>>(row: T): T {
  return {
    ...row,
    createdAt: toUnixSeconds(row.createdAt as Date | null | undefined),
  } as T;
}

const app = new Elysia({ name: "web-registry" }).use(authGuardPlugin).model({
  "event-query": EventQuerySchema,
  "machine-list-response": MachineListResponseSchema,
  "machine-detail-response": MachineDetailResponseSchema,
  "machine-query": MachineQuerySchema,
  "registry-event-list-response": RegistryEventListResponseSchema,
});

app.get(
  "/registry/machines",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 query/response 组合下类型推断不稳定
  async ({ store, query, error }: any) => {
    const authCtx = store.authContext!;
    const q = query as {
      status?: string;
      labels?: string;
      tenantId?: string;
      userId?: string;
      limit?: string;
      offset?: string;
    };
    const labels = q.labels
      ? q.labels
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const limit = q.limit ? Number(q.limit) : 20;
    const offset = q.offset ? Number(q.offset) : 0;
    try {
      const result = await listMachines(authCtx, {
        status: q.status as "online" | "offline" | undefined,
        labels,
        limit,
        offset,
      });
      return { data: result.data.map(serializeMachine), total: Number(result.total) };
    } catch (err: unknown) {
      logger.error("Failed to list machines", err);
      return error(500, { error: { type: "INTERNAL_ERROR", message: (err as Error).message } });
    }
  },
  {
    sessionAuth: true,
    query: "machine-query",
    response: "machine-list-response",
    detail: {
      tags: ["Registry"],
      summary: "获取机器列表",
      description: "分页返回当前组织可见的机器注册列表，支持按状态和标签过滤。",
    },
  },
);

app.get(
  "/registry/machines/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    try {
      const result = await getMachine(authCtx, params.id);
      if (!result) {
        return error(404, { error: { type: "NOT_FOUND", message: "Machine not found" } });
      }
      return {
        data: {
          ...serializeMachine(result),
          recentEvents: result.recentEvents.map(serializeEvent),
        },
      };
    } catch (err: unknown) {
      logger.error("Failed to get machine", err);
      return error(500, { error: { type: "INTERNAL_ERROR", message: (err as Error).message } });
    }
  },
  {
    sessionAuth: true,
    response: "machine-detail-response",
    detail: {
      tags: ["Registry"],
      summary: "获取机器详情",
      description: "根据机器 ID 返回单台机器的完整信息及最近事件。",
    },
  },
);

app.get(
  "/registry/machines/:id/events",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 query/response 组合下类型推断不稳定
  async ({ store, params, query, error }: any) => {
    const authCtx = store.authContext!;
    const q = query as { limit?: string; offset?: string };
    const limit = q.limit ? Number(q.limit) : 20;
    const offset = q.offset ? Number(q.offset) : 0;
    try {
      const result = await listEvents(authCtx, params.id, { limit, offset });
      return { data: result.data.map(serializeEvent), total: Number(result.total) };
    } catch (err: unknown) {
      logger.error("Failed to list machine events", err);
      return error(500, { error: { type: "INTERNAL_ERROR", message: (err as Error).message } });
    }
  },
  {
    sessionAuth: true,
    query: "event-query",
    response: "registry-event-list-response",
    detail: {
      tags: ["Registry"],
      summary: "获取机器事件列表",
      description: "分页返回指定机器的注册表事件历史，用于状态排查和追踪。",
    },
  },
);

export default app;
