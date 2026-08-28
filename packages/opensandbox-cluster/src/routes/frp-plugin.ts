import { timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import type { FrpPluginRequest } from "../schemas/frp-plugin-schemas";
import type { FrpPluginService } from "../services/frp-plugin-service";
import type { ClusterConfig } from "../types";

export function createFrpPluginRoutes(config: ClusterConfig, service: FrpPluginService) {
  return new Elysia({ name: "frp-plugin" }).post(
    "/internal/frp/plugin/:pathToken",
    async ({ params, request, set }) => {
      if (!sameSecret(params.pathToken, config.frpToken)) {
        set.status = 404;
        return { error: "not found" };
      }
      try {
        const body = (await request.json()) as FrpPluginRequest;
        if (!body || typeof body !== "object") throw new Error("invalid body");
        return service.handle(body);
      } catch {
        set.status = 200;
        return { reject: true, reject_reason: "invalid plugin request", unchange: true };
      }
    },
  );
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
