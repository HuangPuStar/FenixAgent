import { createLogger } from "@fenix/logger";
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import {
  MachineDetailResponseSchema,
  MachineListResponseSchema,
  RegistryEventListResponseSchema,
} from "../../schemas/registry.schema";
import { getMachine, listEvents, listMachines } from "../../services/registry";

const logger = createLogger("registry");

const app = new Elysia({ name: "web-registry" }).use(authGuardPlugin).model({
  "machine-list-response": MachineListResponseSchema,
  "machine-detail-response": MachineDetailResponseSchema,
  "registry-event-list-response": RegistryEventListResponseSchema,
});

app.get(
  "/registry/machines",
  async ({ store, query, error }) => {
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
      return { data: result.data, total: result.total };
    } catch (err: unknown) {
      logger.error("Failed to list machines", err);
      return error(500, { error: { type: "INTERNAL_ERROR", message: (err as Error).message } });
    }
  },
  { sessionAuth: true },
);

app.get(
  "/registry/machines/:id",
  async ({ store, params, error }) => {
    const authCtx = store.authContext!;
    try {
      const result = await getMachine(authCtx, params.id);
      if (!result) {
        return error(404, { error: { type: "NOT_FOUND", message: "Machine not found" } });
      }
      return { data: result };
    } catch (err: unknown) {
      logger.error("Failed to get machine", err);
      return error(500, { error: { type: "INTERNAL_ERROR", message: (err as Error).message } });
    }
  },
  { sessionAuth: true },
);

app.get(
  "/registry/machines/:id/events",
  async ({ store, params, query, error }) => {
    const authCtx = store.authContext!;
    const q = query as { limit?: string; offset?: string };
    const limit = q.limit ? Number(q.limit) : 20;
    const offset = q.offset ? Number(q.offset) : 0;
    try {
      const result = await listEvents(authCtx, params.id, { limit, offset });
      return { data: result.data, total: result.total };
    } catch (err: unknown) {
      logger.error("Failed to list machine events", err);
      return error(500, { error: { type: "INTERNAL_ERROR", message: (err as Error).message } });
    }
  },
  { sessionAuth: true },
);

export default app;
