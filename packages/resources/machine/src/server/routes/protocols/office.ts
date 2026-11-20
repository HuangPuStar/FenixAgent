import { createLogger } from "@fenix/logger";
import Elysia from "elysia";
import { z } from "zod/v4";
import { editingFailure } from "../../editing/editing-http";
import { getMachineEditingService } from "../../editing/editing-runtime";

const logger = createLogger("machine-office-protocol");
const tokenParams = z.object({ token: z.string().min(1).max(16384) });
const protocolQuery = z.record(z.string(), z.string());
const protocolHeaders = z.record(z.string(), z.string());
const failureResponse = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});

/** Document provider protocol authenticates signed references, independently of browser cookies. */
export function createOfficeProtocolRoutes() {
  return new Elysia({ name: "machine-office-protocol", prefix: "/office" })
    .get(
      "/documents/:token",
      async ({ params }) => {
        try {
          const snapshot = await getMachineEditingService().document(params.token);
          return new Response(new Uint8Array(snapshot.bytes), {
            headers: {
              "content-type": snapshot.mimeType,
              "content-length": String(snapshot.size),
              "Cache-Control": "no-store",
            },
          });
        } catch (error) {
          return editingFailure(error);
        }
      },
      {
        params: tokenParams,
        query: protocolQuery,
        headers: protocolHeaders,
        response: {
          200: z.string().meta({ format: "binary" }),
          400: failureResponse,
          403: failureResponse,
          404: failureResponse,
          409: failureResponse,
          410: failureResponse,
          413: failureResponse,
          429: failureResponse,
          503: failureResponse,
        },
        detail: { hide: true, tags: ["Office protocol"], summary: "文档服务读取绑定文件" },
      },
    )
    .post(
      "/callbacks/:token",
      async ({ params, body, set }) => {
        set.headers["Cache-Control"] = "no-store";
        try {
          return await getMachineEditingService().callback(params.token, body);
        } catch (error) {
          // Provider exceptions may carry signed paths or callback bytes in arbitrary diagnostic properties.
          logger.error("Office callback failed", { errorType: error instanceof Error ? "Error" : typeof error });
          return { error: 1 };
        }
      },
      {
        params: tokenParams,
        query: protocolQuery,
        headers: protocolHeaders,
        body: z.unknown(),
        response: z.object({ error: z.number() }),
        detail: { hide: true, tags: ["Office protocol"], summary: "文档服务保存回调" },
      },
    );
}
