import { createLogger } from "@fenix/logger";
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { WebErrSchema } from "../../schemas/common.schema";
import {
  EventQuerySchema,
  MachineDetailResponseSchema,
  MachineListResponseSchema,
  MachineQuerySchema,
  RegistryEventListResponseSchema,
} from "../../schemas/registry.schema";
import { getMachine, listEvents, listMachines } from "../../services/registry";

const logger = createLogger("registry");

function internalErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Internal server error";
}

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
  async ({ store, query, status }: any) => {
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
      return {
        success: true,
        data: {
          items: result.data.map(serializeMachine),
          total: Number(result.total),
        },
      };
    } catch (err: unknown) {
      logger.error("Failed to list machines", err);
      return status(500, { success: false, error: { code: "INTERNAL_ERROR", message: internalErrorMessage(err) } });
    }
  },
  {
    sessionAuth: true,
    query: "machine-query",
    response: {
      200: "machine-list-response",
      500: WebErrSchema,
    },
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
  async ({ store, params, status }: any) => {
    const authCtx = store.authContext!;
    try {
      const result = await getMachine(authCtx, params.id);
      if (!result) {
        return status(404, { success: false, error: { code: "NOT_FOUND", message: "Machine not found" } });
      }
      return {
        success: true,
        data: {
          ...serializeMachine(result),
          recentEvents: result.recentEvents.map(serializeEvent),
        },
      };
    } catch (err: unknown) {
      logger.error("Failed to get machine", err);
      return status(500, { success: false, error: { code: "INTERNAL_ERROR", message: internalErrorMessage(err) } });
    }
  },
  {
    sessionAuth: true,
    response: {
      200: "machine-detail-response",
      404: WebErrSchema,
      500: WebErrSchema,
    },
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
  async ({ store, params, query, status }: any) => {
    const authCtx = store.authContext!;
    const q = query as { limit?: string; offset?: string };
    const limit = q.limit ? Number(q.limit) : 20;
    const offset = q.offset ? Number(q.offset) : 0;
    try {
      const result = await listEvents(authCtx, params.id, { limit, offset });
      return {
        success: true,
        data: {
          items: result.data.map(serializeEvent),
          total: Number(result.total),
        },
      };
    } catch (err: unknown) {
      logger.error("Failed to list machine events", err);
      return status(500, { success: false, error: { code: "INTERNAL_ERROR", message: internalErrorMessage(err) } });
    }
  },
  {
    sessionAuth: true,
    query: "event-query",
    response: {
      200: "registry-event-list-response",
      500: WebErrSchema,
    },
    detail: {
      tags: ["Registry"],
      summary: "获取机器事件列表",
      description: "分页返回指定机器的注册表事件历史，用于状态排查和追踪。",
    },
  },
);

export default app;
