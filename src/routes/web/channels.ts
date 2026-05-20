import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { environmentRepo } from "../../repositories";
import {
  ChannelBindingSchema,
  ChannelProviderDescriptorSchema,
  CreateChannelBindingRequestSchema,
  HermesStatusSchema,
} from "../../schemas/channel.schema";
import { createBinding, deleteBinding, listBindings, updateBinding } from "../../services/channel-binding";
import { getChannelProvider, listChannelProviders } from "../../services/channel-provider";
import { getHermesClient } from "../../services/hermes-client";
import { loadOrgContext } from "../../services/org-context";

const app = new Elysia({ name: "web-channels", prefix: "/web" }).use(authGuardPlugin).model({
  "channel-provider-list": ChannelProviderDescriptorSchema.array(),
  "hermes-status": HermesStatusSchema,
  "channel-binding": ChannelBindingSchema,
  "channel-binding-list": ChannelBindingSchema.array(),
  "create-channel-binding-request": CreateChannelBindingRequestSchema,
});

app.get(
  "/channels/providers",
  () => {
    return listChannelProviders();
  },
  { sessionAuth: true, response: "channel-provider-list" },
);

app.get(
  "/channels",
  () => {
    return [];
  },
  { sessionAuth: true, response: "channel-binding-list" },
);

app.post(
  "/channels",
  async ({ body, error }) => {
    const b = body as { type?: string };
    const provider = typeof b?.type === "string" ? getChannelProvider(b.type) : undefined;
    const status = provider ? 409 : 400;
    return error(status, { error: { type: "FORBIDDEN", message: "当前平台暂未开放" } });
  },
  { sessionAuth: true },
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
  { sessionAuth: true, response: "hermes-status" },
);

// --- Bindings CRUD ---

app.get(
  "/channels/bindings",
  async ({ store, request }) => {
    const authCtx = (await loadOrgContext(store.user!, request))!;
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
  { sessionAuth: true, response: "channel-binding-list" },
);

app.post(
  "/channels/bindings",
  async ({ store, body, error, request }) => {
    const authCtx = (await loadOrgContext(store.user!, request))!;
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
  { sessionAuth: true, body: "create-channel-binding-request" },
);

app.delete(
  "/channels/bindings/:id",
  async ({ store, params, error, request }) => {
    const authCtx = (await loadOrgContext(store.user!, request))!;
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
  { sessionAuth: true },
);

app.patch(
  "/channels/bindings/:id",
  async ({ store, params, body, error, request }) => {
    const authCtx = (await loadOrgContext(store.user!, request))!;
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
  { sessionAuth: true },
);

export default app;
