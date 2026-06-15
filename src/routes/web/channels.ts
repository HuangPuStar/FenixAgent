import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { environmentRepo } from "../../repositories";
import {
  ChannelBindingListResponseSchema,
  ChannelBindingSchema,
  ChannelProviderDescriptorSchema,
  ChannelProviderListResponseSchema,
  CreateChannelBindingRequestSchema,
  CreateChannelBindingResponseSchema,
  DeleteChannelBindingResponseSchema,
  HermesStatusSchema,
  UpdateChannelBindingRequestSchema,
  UpdateChannelBindingResponseSchema,
} from "../../schemas/channel.schema";
import { createBinding, deleteBinding, listBindings, updateBinding } from "../../services/channel-binding";
import { getChannelProvider, listChannelProviders } from "../../services/channel-provider";
import { getHermesClient } from "../../services/hermes-client";

const app = new Elysia({ name: "web-channels" }).use(authGuardPlugin).model({
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
    return listChannelProviders();
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
  "/channels",
  () => {
    return [];
  },
  {
    sessionAuth: true,
    response: "channel-binding-list",
    detail: {
      tags: ["Channels"],
      summary: "获取通道列表",
      description: "历史兼容接口；当前返回空列表，不作为通道绑定数据源使用。",
    },
  },
);

app.post(
  "/channels",
  // biome-ignore lint/suspicious/noExplicitAny: 当前仅保留兼容入口，文档补充不改变现有错误分支
  async ({ body, error }: any) => {
    const b = body as { type?: string };
    const provider = typeof b?.type === "string" ? getChannelProvider(b.type) : undefined;
    const status = provider ? 409 : 400;
    return error(status, { error: { type: "FORBIDDEN", message: "当前平台暂未开放" } });
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Channels"],
      summary: "创建通道",
      description: "历史兼容接口；当前平台未开放该能力，请改用通道绑定接口。",
    },
  },
);

// --- Hermes Status ---

app.get(
  "/channels/hermes/status",
  () => {
    const client = getHermesClient();
    if (!client) {
      return {
        connected: false,
        url: "",
        platforms: [],
        reconnecting: false,
        lastConnectedAt: null,
      };
    }
    return client.getStatus();
  },
  {
    sessionAuth: true,
    response: "hermes-status",
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
    const authCtx = store.authContext!;
    // 获取团队所有 environmentId
    const teamEnvs = await environmentRepo.listByOrganizationId(authCtx.organizationId);
    const teamEnvIds = new Set(teamEnvs.map((e) => e.id));
    const bindings = await listBindings();
    // 仅返回 agentId 属于当前团队的绑定
    const filtered = bindings.filter((b) => teamEnvIds.has(b.agentId));
    const enriched = [];
    for (const b of filtered) {
      const env = await environmentRepo.getById(b.agentId);
      enriched.push({ ...b, agentName: env?.name ?? null });
    }
    return enriched;
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
    const authCtx = store.authContext!;
    const b = body as { platform: string; chatId?: string | null; agentId: string; enabled?: boolean };
    if (!b.platform || !b.agentId) {
      return error(400, { error: { type: "VALIDATION_ERROR", message: "platform 和 agentId 为必填字段" } });
    }
    // 验证 agentId 属于当前团队
    const env = await environmentRepo.getById(b.agentId);
    if (!env || env.organizationId !== authCtx.organizationId) {
      return error(404, { error: { type: "NOT_FOUND", message: "Agent 不存在" } });
    }
    const binding = await createBinding({
      platform: b.platform,
      chatId: b.chatId ?? null,
      agentId: b.agentId,
      enabled: b.enabled,
    });
    return { ...binding, agentName: env?.name ?? null };
  },
  {
    sessionAuth: true,
    body: "create-channel-binding-request",
    response: "create-channel-binding-response",
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
    const authCtx = store.authContext!;
    const id = params.id;
    // 验证绑定关联的 agent 属于当前团队
    const binding = await listBindings();
    const target = binding.find((b) => b.id === id);
    if (!target) {
      return error(404, { error: { type: "NOT_FOUND", message: "绑定不存在" } });
    }
    const env = await environmentRepo.getById(target.agentId);
    if (!env || env.organizationId !== authCtx.organizationId) {
      return error(403, { error: { type: "FORBIDDEN", message: "无权操作此绑定" } });
    }
    const deleted = await deleteBinding(id);
    if (!deleted) {
      return error(404, { error: { type: "NOT_FOUND", message: "绑定不存在" } });
    }
    return { success: true as const };
  },
  {
    sessionAuth: true,
    response: "delete-channel-binding-response",
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
    const authCtx = store.authContext!;
    const id = params.id;
    // 验证绑定关联的 agent 属于当前团队
    const binding = await listBindings();
    const target = binding.find((b) => b.id === id);
    if (!target) {
      return error(404, { error: { type: "NOT_FOUND", message: "绑定不存在" } });
    }
    const env = await environmentRepo.getById(target.agentId);
    if (!env || env.organizationId !== authCtx.organizationId) {
      return error(403, { error: { type: "FORBIDDEN", message: "无权操作此绑定" } });
    }
    const b = body as Record<string, unknown>;
    const updated = await updateBinding(id, b);
    if (!updated) {
      return error(404, { error: { type: "NOT_FOUND", message: "绑定不存在" } });
    }
    const updatedEnv = await environmentRepo.getById(updated.agentId);
    return { ...updated, agentName: updatedEnv?.name ?? null };
  },
  {
    sessionAuth: true,
    body: "update-channel-binding-request",
    response: "update-channel-binding-response",
    detail: {
      tags: ["Channels"],
      summary: "更新通道绑定",
      description: "更新指定通道绑定的目标环境、聊天 ID 或启用状态。",
    },
  },
);

export default app;
