import { WebErrSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { type ChannelBindingErrorCode, createChannelBindingFacade } from "../../facades/channel-binding-facade";
import {
  ChannelBindingListResponseSchema,
  ChannelBindingSchema,
  ChannelProviderDescriptorSchema,
  ChannelProviderListResponseSchema,
  CreateChannelBindingRequestSchema,
  CreateChannelBindingResponseSchema,
  DeleteChannelBindingResponseSchema,
  HermesStatusResponseSchema,
  HermesStatusSchema,
  UpdateChannelBindingRequestSchema,
  UpdateChannelBindingResponseSchema,
} from "../../schemas/channel.schema";
import { listChannelProviders } from "../../services/channel-provider";
import { getHermesClient } from "../../services/hermes-client";
import type { WebChannelRouteDependencies } from "../dependencies";

/**
 * 门面失败码 → 协议响应。
 *
 * 映射只有这一处，三个写端点共用：`NOT_FOUND` → 404（目标不可见或不存在，跨组织与不存在同形）、
 * `FORBIDDEN` → 403（绑定存在但无权操作）。两个口径与迁移前逐条一致，不新增也不放宽。
 */
function toErrorResponse(
  error: (status: number, body: unknown) => Response,
  failure: { readonly error: { readonly code: ChannelBindingErrorCode; readonly message: string } },
): Response {
  return error(failure.error.code === "FORBIDDEN" ? 403 : 404, { success: false, error: failure.error });
}

/**
 * `/web/channels/*` — IM 通道平台、Hermes 状态与通道绑定的控制台协议适配层。
 *
 * 改为工厂（对齐 `@fenix/resource-sandbox/server`）：守卫必须与宿主的认证解析是同一份实例
 * （Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填），Environment
 * 归属查询的 owner 是 `@fenix/agent-runtime`，两者都由宿主注入，理由见 `../dependencies`。
 * 路由只声明相对于宿主 `/web` 路由组的前缀（宿主 `.use()` 时加 `/web`）。
 *
 * 组织隔离规则**不在本层**：绑定的可见性与可写性由「绑定目标 Environment 属于调用者组织」决定，
 * 该判断（含列表的可见集与写操作的拒绝口径）收敛在 `../../facades/channel-binding-facade`；路由只把
 * 宿主的认证上下文交给门面，再把门面的失败码映射成 404 / 403。
 */
export function createWebChannelsRoutes(deps: WebChannelRouteDependencies) {
  // 门面与路由共用宿主注入的同一份 `environmentLookup`：归属查询没有第二份实现。
  const facade = createChannelBindingFacade({ environmentLookup: deps.environmentLookup });
  const app = new Elysia({ name: "web-channels" }).use(deps.authGuardPlugin).model({
    "channel-provider": ChannelProviderDescriptorSchema,
    "channel-provider-list": ChannelProviderListResponseSchema,
    "hermes-status": HermesStatusSchema,
    "channel-binding": ChannelBindingSchema,
    "channel-binding-list": ChannelBindingListResponseSchema,
    "create-channel-binding-request": CreateChannelBindingRequestSchema,
    "create-channel-binding-response": CreateChannelBindingResponseSchema,
    "update-channel-binding-request": UpdateChannelBindingRequestSchema,
    "update-channel-binding-response": UpdateChannelBindingResponseSchema,
    "delete-channel-binding-response": DeleteChannelBindingResponseSchema,
  });

  app.get(
    "/channels/providers",
    () => {
      return { success: true as const, data: listChannelProviders() };
    },
    {
      sessionAuth: true,
      response: "channel-provider-list",
      detail: {
        tags: ["Channels"],
        summary: "获取通道平台列表",
        description: "返回当前系统支持的 IM 通道平台及其启用状态。",
      },
    },
  );

  app.get(
    "/channels/hermes/status",
    () => {
      const client = getHermesClient();
      if (!client) {
        return {
          success: true as const,
          data: {
            connected: false,
            url: "",
            platforms: [],
            reconnecting: false,
            lastConnectedAt: null,
          },
        };
      }
      return { success: true as const, data: client.getStatus() };
    },
    {
      sessionAuth: true,
      response: HermesStatusResponseSchema,
      detail: {
        tags: ["Channels"],
        summary: "获取 Hermes 状态",
        description: "返回 Hermes 通道网关的连接状态、可用平台和最近连接时间。",
      },
    },
  );

  // --- Bindings CRUD ---

  app.get(
    "/channels/bindings",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + 异步分支组合下类型推断不稳定
    async ({ store, request: _request }: any) => {
      const actor = store.authContext!;
      return { success: true as const, data: await facade.list(actor) };
    },
    {
      sessionAuth: true,
      response: "channel-binding-list",
      detail: {
        tags: ["Channels"],
        summary: "获取通道绑定列表",
        description: "返回当前组织下的通道绑定列表，并附带关联环境名称。",
      },
    },
  );

  app.post(
    "/channels/bindings",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, body, error, request: _request }: any) => {
      const actor = store.authContext!;
      const b = body as { platform: string; chatId?: string | null; agentId: string; enabled?: boolean };
      if (!b.platform || !b.agentId) {
        return error(400, {
          success: false,
          error: { code: "VALIDATION_ERROR", message: "platform 和 agentId 为必填字段" },
        });
      }
      const result = await facade.create(actor, {
        platform: b.platform,
        chatId: b.chatId ?? null,
        agentId: b.agentId,
        enabled: b.enabled,
      });
      if (!result.success) return toErrorResponse(error, result);
      return { success: true as const, data: result.data };
    },
    {
      sessionAuth: true,
      body: "create-channel-binding-request",
      response: {
        200: "create-channel-binding-response",
        400: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Channels"],
        summary: "创建通道绑定",
        description: "为指定平台和环境创建通道绑定，用于将外部消息路由到目标环境。",
      },
    },
  );

  app.delete(
    "/channels/bindings/:id",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, params, error, request: _request }: any) => {
      const actor = store.authContext!;
      const result = await facade.remove(actor, params.id);
      if (!result.success) return toErrorResponse(error, result);
      return { success: true as const, data: null };
    },
    {
      sessionAuth: true,
      response: {
        200: "delete-channel-binding-response",
        403: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Channels"],
        summary: "删除通道绑定",
        description: "删除指定的通道绑定，并校验该绑定是否属于当前组织。",
      },
    },
  );

  app.patch(
    "/channels/bindings/:id",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, params, body, error, request: _request }: any) => {
      const actor = store.authContext!;
      const b = body as { platform?: string; chatId?: string | null; agentId?: string; enabled?: boolean };
      // 归属校验（原绑定的环境，以及请求体里作为**新**目标的 `agentId`）都在门面内，且与 POST 同一口径。
      const result = await facade.update(actor, params.id, b);
      if (!result.success) return toErrorResponse(error, result);
      return { success: true as const, data: result.data };
    },
    {
      sessionAuth: true,
      body: "update-channel-binding-request",
      response: {
        200: "update-channel-binding-response",
        403: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Channels"],
        summary: "更新通道绑定",
        description: "更新指定通道绑定的目标环境、聊天 ID 或启用状态。",
      },
    },
  );

  return app;
}
