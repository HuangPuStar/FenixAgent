import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { getChannelProvider, listChannelProviders } from "../../services/channel-provider";
import { getHermesClient } from "../../services/hermes-client";
import { listBindings, createBinding, deleteBinding, updateBinding } from "../../services/channel-binding";
import { environmentRepo } from "../../repositories";
import {
  ChannelProviderDescriptorSchema,
  HermesStatusSchema,
  ChannelBindingSchema,
  CreateChannelBindingRequestSchema,
} from "../../schemas/channel.schema";

const app = new Elysia({ name: "web-channels", prefix: "/web" })
  .use(authGuardPlugin)
  .model({
    "channel-provider-list": ChannelProviderDescriptorSchema.array(),
    "hermes-status": HermesStatusSchema,
    "channel-binding": ChannelBindingSchema,
    "channel-binding-list": ChannelBindingSchema.array(),
    "create-channel-binding-request": CreateChannelBindingRequestSchema,
  });

app.get("/channels/providers", () => {
  return listChannelProviders();
}, { sessionAuth: true, response: "channel-provider-list" });

app.get("/channels", () => {
  return [];
}, { sessionAuth: true, response: "channel-binding-list" });

app.post("/channels", async ({ body, error }) => {
  const b = body as { type?: string };
  const provider = typeof b?.type === "string" ? getChannelProvider(b.type) : undefined;
  const status = provider ? 409 : 400;
  return error(status, { error: { type: "FORBIDDEN", message: "当前平台暂未开放" } });
}, { sessionAuth: true });

// --- Hermes Status ---

app.get("/channels/hermes/status", () => {
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
}, { sessionAuth: true, response: "hermes-status" });

// --- Bindings CRUD ---

app.get("/channels/bindings", async () => {
  const bindings = await listBindings();
  const enriched = [];
  for (const b of bindings) {
    const env = await environmentRepo.getById(b.agentId);
    enriched.push({ ...b, agentName: env?.name ?? null });
  }
  return enriched;
}, { sessionAuth: true, response: "channel-binding-list" });

app.post("/channels/bindings", async ({ body, error }) => {
  const b = body as { platform: string; chatId?: string | null; agentId: string; enabled?: boolean };
  if (!b.platform || !b.agentId) {
    return error(400, { error: { type: "VALIDATION_ERROR", message: "platform 和 agentId 为必填字段" } });
  }
  const binding = await createBinding({ platform: b.platform, chatId: b.chatId ?? null, agentId: b.agentId, enabled: b.enabled });
  const env = await environmentRepo.getById(binding.agentId);
  return { ...binding, agentName: env?.name ?? null };
}, { sessionAuth: true, body: "create-channel-binding-request" });

app.delete("/channels/bindings/:id", async ({ params, error }) => {
  const id = params.id;
  const deleted = await deleteBinding(id);
  if (!deleted) {
    return error(404, { error: { type: "NOT_FOUND", message: "绑定不存在" } });
  }
  return { success: true as const };
}, { sessionAuth: true });

app.patch("/channels/bindings/:id", async ({ params, body, error }) => {
  const id = params.id;
  const b = body as Record<string, unknown>;
  const updated = await updateBinding(id, b);
  if (!updated) {
    return error(404, { error: { type: "NOT_FOUND", message: "绑定不存在" } });
  }
  const env = await environmentRepo.getById(updated.agentId);
  return { ...updated, agentName: env?.name ?? null };
}, { sessionAuth: true });

export default app;
