import Elysia, { status } from "elysia";
import * as z from "zod/v4";
import { systemApiAuthPlugin } from "../../plugins/system-api-auth";
import { ApiErrorResponseSchema } from "../../schemas/api-common.schema";
import {
  RemoteSandboxListQuerySchema,
  RemoteSandboxListResponseSchema,
  RemoteSandboxSchema,
  SandboxServerCommandBodySchema,
  SandboxServerSandboxParamsSchema,
} from "../../schemas/api-sandbox-server.schema";
import {
  type SandboxServerAdminService,
  sandboxServerAdminService,
} from "../../services/sandbox/sandbox-server-admin-service";
import { mapSandboxClusterAdminError } from "./sandbox-cluster";

let service: SandboxServerAdminService = sandboxServerAdminService;

export function setSandboxServerAdminServiceForTests(next: SandboxServerAdminService | null): void {
  service = next ?? sandboxServerAdminService;
}

const app = new Elysia({ name: "api-sandbox-server", prefix: "/api/system/sandbox-server" })
  .use(systemApiAuthPlugin)
  .model({
    "sandbox-server-sandbox": RemoteSandboxSchema,
    "sandbox-server-sandbox-list": RemoteSandboxListResponseSchema,
  })
  .get(
    "/servers/:serverId/sandboxes",
    async ({ params, query }) => {
      try {
        return (await service.listSandboxes(params.serverId, query)) as z.infer<typeof RemoteSandboxListResponseSchema>;
      } catch (error) {
        const mapped = mapSandboxClusterAdminError(error);
        return status(mapped.status, mapped.body);
      }
    },
    {
      systemApiKeyAuth: true,
      params: SandboxServerSandboxParamsSchema.pick({ serverId: true }),
      query: RemoteSandboxListQuerySchema,
      response: {
        200: "sandbox-server-sandbox-list",
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        502: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["System Sandbox"],
        summary: "获取远程沙盒列表",
        description: "查询指定 OpenSandbox Server 当前实际存在的远程沙盒。",
      },
    },
  )
  .get(
    "/servers/:serverId/sandboxes/:sandboxId",
    async ({ params }) => {
      try {
        return (await service.getSandbox(params.serverId, params.sandboxId)) as z.infer<typeof RemoteSandboxSchema>;
      } catch (error) {
        const mapped = mapSandboxClusterAdminError(error);
        return status(mapped.status, mapped.body);
      }
    },
    {
      systemApiKeyAuth: true,
      params: SandboxServerSandboxParamsSchema,
      response: {
        200: "sandbox-server-sandbox",
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        502: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["System Sandbox"],
        summary: "获取远程沙盒详情",
        description: "查询指定 OpenSandbox Server 上远程沙盒的状态和配置。",
      },
    },
  )
  .get(
    "/servers/:serverId/sandboxes/:sandboxId/diagnostics",
    async ({ params, set }) => {
      try {
        set.headers["content-type"] = "text/plain; charset=utf-8";
        set.headers["cache-control"] = "no-store";
        return await service.getDiagnostics(params.serverId, params.sandboxId);
      } catch (error) {
        const mapped = mapSandboxClusterAdminError(error);
        return status(mapped.status, mapped.body);
      }
    },
    {
      systemApiKeyAuth: true,
      params: SandboxServerSandboxParamsSchema,
      response: {
        200: z.string(),
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        502: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["System Sandbox"],
        summary: "获取远程沙盒诊断概览",
        description: "获取远程沙盒容器状态、资源、事件和最近日志。",
      },
    },
  )
  .post(
    "/servers/:serverId/sandboxes/:sandboxId/commands",
    async ({ params, body, request }) => {
      try {
        const upstream = await service.executeCommandStream(params.serverId, params.sandboxId, body, request.signal);
        return new Response(upstream.body, {
          status: upstream.status,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        });
      } catch (error) {
        const mapped = mapSandboxClusterAdminError(error);
        return status(mapped.status, mapped.body) as never;
      }
    },
    {
      systemApiKeyAuth: true,
      params: SandboxServerSandboxParamsSchema,
      body: SandboxServerCommandBodySchema,
      response: {
        200: z.string(),
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        502: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["System Sandbox"],
        summary: "在远程沙盒中执行命令",
        description: "在指定远程沙盒中执行只读或诊断命令，并以 SSE 透传 Execd 输出。",
      },
    },
  );

export default app;
