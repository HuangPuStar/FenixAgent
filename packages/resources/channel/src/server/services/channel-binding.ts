import type { ChannelBindingRow } from "../repositories/channel-binding";
import { channelBindingRepo } from "../repositories/channel-binding";

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

/** 绑定的可更新字段；`platform` / `chatId` / `agentId` / `enabled` 之外一律不接受。 */
export type UpdateBindingInput = Partial<Pick<ChannelBinding, "platform" | "chatId" | "agentId" | "enabled">>;

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

/**
 * 按绑定的目标 Environment 读取绑定。
 *
 * `agentIds` 是调用方（Facade）从 actor 的组织推导出的归属范围——本层不解释组织、不比较 `organizationId`，
 * 只把给定的范围下推成查询条件。传入空集合返回空列表（见仓储说明）。
 */
export async function listBindingsByAgentIds(agentIds: readonly string[]): Promise<ChannelBinding[]> {
  const rows = await channelBindingRepo.listByAgentIds(agentIds);
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

export async function updateBinding(id: string, data: UpdateBindingInput): Promise<ChannelBinding | undefined> {
  const existing = await channelBindingRepo.getById(id);
  if (!existing) return;
  await channelBindingRepo.update(id, { ...data, updatedAt: new Date() });
  return getBinding(id);
}

// --- Message Matching ---

export async function findBindingForMessage(platform: string, chatId: string): Promise<BindingMatchResult | undefined> {
  const rows = await channelBindingRepo.listByPlatformAndEnabled(platform);

  const bindings = rows.map(rowToBinding);

  const exact = bindings.find((b) => b.chatId === chatId);
  if (exact) return { binding: exact, matchType: "exact" };

  const wildcard = bindings.find((b) => b.chatId === null);
  if (wildcard) return { binding: wildcard, matchType: "wildcard" };

  return;
}
