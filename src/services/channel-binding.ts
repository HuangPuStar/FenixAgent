import { channelBindingRepo } from "../repositories/channel-binding";
import type { ChannelBindingRow } from "../repositories/channel-binding";

// --- Types ---

export interface ChannelBinding {
  id: string;
  platform: string;
  chatId: string | null;
  agentId: string;
  enabled: boolean;
}

export interface CreateBindingInput {
  platform: string;
  chatId?: string | null;
  agentId: string;
  enabled?: boolean;
}

export interface BindingMatchResult {
  binding: ChannelBinding;
  matchType: "exact" | "wildcard";
}

// --- Helper ---

function rowToBinding(row: ChannelBindingRow): ChannelBinding {
  return {
    id: row.id,
    platform: row.platform,
    chatId: row.chatId ?? null,
    agentId: row.agentId,
    enabled: row.enabled,
  };
}

// --- CRUD ---

export async function listBindings(): Promise<ChannelBinding[]> {
  const rows = await channelBindingRepo.list();
  return rows.map(rowToBinding);
}

export async function getBinding(id: string): Promise<ChannelBinding | undefined> {
  const row = await channelBindingRepo.getById(id);
  return row ? rowToBinding(row) : undefined;
}

export async function createBinding(data: CreateBindingInput): Promise<ChannelBinding> {
  const now = new Date();
  const row = await channelBindingRepo.create({
    platform: data.platform,
    chatId: data.chatId ?? null,
    agentId: data.agentId,
    enabled: data.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  });
  return rowToBinding(row);
}

export async function deleteBinding(id: string): Promise<boolean> {
  return channelBindingRepo.delete(id);
}

export async function updateBinding(
  id: string,
  data: Partial<Pick<ChannelBinding, "platform" | "chatId" | "agentId" | "enabled">>,
): Promise<ChannelBinding | undefined> {
  const existing = await channelBindingRepo.getById(id);
  if (!existing) return undefined;
  await channelBindingRepo.update(id, { ...data, updatedAt: new Date() });
  return getBinding(id);
}

// --- Message Matching ---

export async function findBindingForMessage(
  platform: string,
  chatId: string,
): Promise<BindingMatchResult | undefined> {
  const rows = await channelBindingRepo.listByPlatformAndEnabled(platform);

  const bindings = rows.map(rowToBinding);

  const exact = bindings.find((b) => b.chatId === chatId);
  if (exact) return { binding: exact, matchType: "exact" };

  const wildcard = bindings.find((b) => b.chatId === null);
  if (wildcard) return { binding: wildcard, matchType: "wildcard" };

  return undefined;
}
