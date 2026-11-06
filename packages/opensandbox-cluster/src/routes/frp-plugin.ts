import { timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import { createRequestLogging, type HttpLogSink, recordRequestError } from "../logging/http-logger";
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
        const result = service.handle(body);
        if (result.reject) recordRequestError(request, new Error(result.reject_reason));
        return result;
      } catch (error) {
        recordRequestError(request, error);
        set.status = 200;
        return { reject: true, reject_reason: "invalid plugin request", unchange: true };
      }
    },
  );
}

/** The private plugin port is a separate HTTP application and needs its own lifecycle hooks. */
export function createLoggedFrpPluginApp(config: ClusterConfig, service: FrpPluginService, httpLog?: HttpLogSink) {
  const logging = createRequestLogging([config.frpToken, config.clusterServiceApiKey], httpLog);
  return new Elysia({ name: "frp-plugin-host" })
    .onRequest(logging.start)
    .mapResponse(logging.captureResponse)
    .onAfterResponse(logging.finish)
    .use(createFrpPluginRoutes(config, service));
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
