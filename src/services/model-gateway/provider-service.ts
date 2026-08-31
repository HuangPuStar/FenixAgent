import { error as logError } from "@fenix/logger";
import type { GatewayModel, ModelGatewayAdapter } from "@fenix/model-gateway-sdk";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import type { AuthContext } from "../../plugins/auth";
import { addModel, removeModel, updateModel } from "../config/model";
import { getProvider, getProviderById, upsertProvider } from "../config/provider";
import type { ProviderUpsertData } from "../config/types";
import { setPublicRead } from "../resource-permission";
import { ensureSystemAdmin } from "../system-admin";

export const SYSTEM_MODEL_GATEWAY_PROVIDER_NAME = "fenix-model-gateway";

export interface SystemModelGatewayProviderOptions {
  baseUrl: string;
  gatewayType: string;
  displayName?: string;
}

interface ProviderServiceDeps {
  ensureSystemAdmin: typeof ensureSystemAdmin;
  upsertProvider: typeof upsertProvider;
  setPublicRead: typeof setPublicRead;
  getProviderById: typeof getProviderById;
  getProvider: typeof getProvider;
  addModel: typeof addModel;
  updateModel: typeof updateModel;
  removeModel: typeof removeModel;
  adapter?: ModelGatewayAdapter;
  invalidateModelCache: () => void;
  withModelSyncLock: <T>(fn: () => Promise<T>) => Promise<T>;
}

export type ModelSyncChange = {
  modelId: string;
  kind: "added" | "updated" | "removed";
  displayName?: string;
};

export type ModelGatewayProviderSummary = {
  id: string;
  name: string;
  displayName: string;
  gatewayType: string;
  baseUrl: string | null;
  modelCount: number;
  owner: { email: string; organizationSlug: string };
};

export type ModelSyncCheckResult =
  | {
      status: "synced" | "pending";
      changes: ModelSyncChange[];
      models: GatewayModel[];
      provider: ModelGatewayProviderSummary;
      providerBaseUrlChanged?: boolean;
    }
  | { status: "unknown"; changes: []; error: string };

export type ModelSyncResult = { added: number; updated: number; removed: number };

export type ModelGatewayModelSyncDeps = Partial<ProviderServiceDeps>;

/**
 * 使用事务级 advisory lock 串行化模型投影同步。
 *
 * 当前模型写入服务仍使用宿主 db 连接，事务在这里主要负责持有跨实例锁；
 * 具体写入失败会中止后续操作，下一次手动同步可重新对齐投影。
 */
async function withDatabaseModelSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('fenix:model-gateway:models', 0))`);
    return fn();
  });
}

/**
 * 系统模型网关 Provider 编排。
 *
 * Provider 是 Fenix 的公开消费投影，所有上游管理凭证都保留在 Adapter 配置中，
 * 因此这里明确写入空 apiKey，避免把 LiteLLM Master Key 暴露给 Agent。
 */
export function createSystemModelGatewayProviderService(
  deps: Partial<ProviderServiceDeps> = {},
  options: SystemModelGatewayProviderOptions,
) {
  if (!options) throw new Error("model gateway provider options are required");
  if (!options.baseUrl.trim()) throw new Error("model gateway provider baseUrl is required");
  if (!options.gatewayType.trim()) throw new Error("model gateway provider gatewayType is required");
  const resolvedDeps: ProviderServiceDeps = {
    ensureSystemAdmin: deps.ensureSystemAdmin ?? ensureSystemAdmin,
    upsertProvider: deps.upsertProvider ?? upsertProvider,
    setPublicRead: deps.setPublicRead ?? setPublicRead,
    getProviderById: deps.getProviderById ?? getProviderById,
    getProvider: deps.getProvider ?? getProvider,
    addModel: deps.addModel ?? addModel,
    updateModel: deps.updateModel ?? updateModel,
    removeModel: deps.removeModel ?? removeModel,
    adapter: deps.adapter,
    invalidateModelCache: deps.invalidateModelCache ?? (() => {}),
    withModelSyncLock: deps.withModelSyncLock ?? withDatabaseModelSyncLock,
  };

  async function getGatewayContext() {
    const admin = await resolvedDeps.ensureSystemAdmin();
    return {
      admin,
      context: {
        organizationId: admin.organization.id,
        userId: admin.userId,
        role: "owner" as const,
      } satisfies AuthContext,
    };
  }

  function getAdapter() {
    if (!resolvedDeps.adapter) throw new Error("model gateway adapter is not configured");
    return resolvedDeps.adapter;
  }

  async function readModels(providerId: string) {
    const { admin, context } = await getGatewayContext();
    const providerRow = await resolvedDeps.getProviderById(context, providerId);
    if (providerRow?.kind !== "gateway") throw new Error("model gateway provider not found");
    if (providerRow.gatewayType !== options.gatewayType) throw new Error("model gateway type mismatch");
    return { admin, context, providerRow, remoteModels: await getAdapter().listModels() };
  }

  function diffModels(existing: Array<{ modelId: string; displayName: string | null }>, remote: GatewayModel[]) {
    const existingById = new Map(existing.map((item) => [item.modelId, item]));
    const remoteById = new Map(remote.map((item) => [item.id, item]));
    const changes: ModelSyncChange[] = [];
    for (const item of remote) {
      const current = existingById.get(item.id);
      const displayName = item.displayName ?? item.id;
      if (!current) changes.push({ modelId: item.id, kind: "added", displayName });
      else if (current.displayName !== displayName) changes.push({ modelId: item.id, kind: "updated", displayName });
    }
    for (const item of existing) {
      if (!remoteById.has(item.modelId)) {
        changes.push({ modelId: item.modelId, kind: "removed", displayName: item.displayName ?? item.modelId });
      }
    }
    return changes;
  }

  return {
    /** 返回当前调用者可读取的指定 Gateway Provider 摘要，供 Provider 上下文页面使用。 */
    async getProviderForUsage(context: AuthContext, providerId: string) {
      const provider = await resolvedDeps.getProviderById(context, providerId);
      if (provider?.kind !== "gateway" || provider.gatewayType !== options.gatewayType) {
        throw new Error("model gateway provider is unavailable");
      }
      return {
        id: provider.id,
        name: provider.name,
        displayName: provider.displayName ?? provider.name,
      };
    },
    /** 读取本地 Gateway Provider 投影，不访问 LiteLLM 上游。 */
    async getConfiguration(): Promise<{ provider: ModelGatewayProviderSummary | null }> {
      const { admin, context } = await getGatewayContext();
      const providerRow = await resolvedDeps.getProvider(context, SYSTEM_MODEL_GATEWAY_PROVIDER_NAME);
      if (providerRow?.kind !== "gateway") return { provider: null };
      return {
        provider: {
          id: providerRow.id,
          name: providerRow.name,
          displayName: providerRow.displayName ?? SYSTEM_MODEL_GATEWAY_PROVIDER_NAME,
          gatewayType: providerRow.gatewayType ?? options.gatewayType,
          baseUrl: providerRow.baseUrl,
          modelCount: providerRow.models?.length ?? 0,
          owner: { email: admin.email, organizationSlug: admin.organization.slug },
        },
      };
    },
    /** 获取现有系统 Provider，不更新其配置，用于检查配置差异。 */
    async getProviderForCheck(): Promise<string> {
      return this.ensureProvider();
    },
    async ensureProvider(): Promise<string> {
      const { admin, context } = await getGatewayContext();
      const existing = await resolvedDeps.getProvider(context, SYSTEM_MODEL_GATEWAY_PROVIDER_NAME);
      if (existing) {
        if (existing.kind !== "gateway") throw new Error("system model gateway provider has an invalid kind");
        return existing.id;
      }
      const data: ProviderUpsertData = {
        displayName: options.displayName ?? "全局模型网关",
        kind: "gateway",
        gatewayType: options.gatewayType,
        protocol: "openai",
        baseUrl: options.baseUrl,
        apiKey: null,
      };
      const providerId = await resolvedDeps.upsertProvider(context, SYSTEM_MODEL_GATEWAY_PROVIDER_NAME, data);
      await resolvedDeps.setPublicRead(context, "provider", admin.organization.id, providerId, true);
      return providerId;
    },
    async checkModels(providerId: string): Promise<ModelSyncCheckResult> {
      try {
        const { admin, providerRow, remoteModels } = await readModels(providerId);
        const changes = diffModels(providerRow.models ?? [], remoteModels);
        const providerBaseUrlChanged = providerRow.baseUrl !== options.baseUrl;
        return {
          status: changes.length > 0 || providerBaseUrlChanged ? "pending" : "synced",
          changes,
          models: remoteModels,
          provider: {
            id: providerRow.id,
            name: providerRow.name,
            displayName: providerRow.displayName ?? SYSTEM_MODEL_GATEWAY_PROVIDER_NAME,
            gatewayType: providerRow.gatewayType ?? options.gatewayType,
            baseUrl: providerRow.baseUrl,
            modelCount: providerRow.models?.length ?? 0,
            owner: { email: admin.email, organizationSlug: admin.organization.slug },
          },
          ...(providerBaseUrlChanged ? { providerBaseUrlChanged: true } : {}),
        };
      } catch (error) {
        logError("[Model-Gateway] check models through adapter failed", error);
        return {
          status: "unknown",
          changes: [],
          error: error instanceof Error ? error.message : "model gateway check failed",
        };
      }
    },
    async syncModels(providerId: string): Promise<ModelSyncResult> {
      return resolvedDeps.withModelSyncLock(async () => {
        const { context, providerRow, remoteModels } = await readModels(providerId);
        // 配置变更在同步动作中落库，检查动作保持只读，避免掩盖待同步状态。
        if (providerRow.baseUrl !== options.baseUrl) {
          await resolvedDeps.upsertProvider(context, SYSTEM_MODEL_GATEWAY_PROVIDER_NAME, {
            displayName: options.displayName ?? "全局模型网关",
            kind: "gateway",
            gatewayType: options.gatewayType,
            protocol: "openai",
            baseUrl: options.baseUrl,
            apiKey: null,
          });
        }
        const changes = diffModels(providerRow.models ?? [], remoteModels);
        let added = 0;
        let updated = 0;
        let removed = 0;
        for (const change of changes) {
          if (change.kind === "added") {
            await resolvedDeps.addModel(context, providerId, {
              modelId: change.modelId,
              displayName: change.displayName,
            });
            added += 1;
          } else if (change.kind === "updated") {
            await resolvedDeps.updateModel(context, providerId, change.modelId, {
              displayName: change.displayName,
            });
            updated += 1;
          } else {
            await resolvedDeps.removeModel(context, providerId, change.modelId);
            removed += 1;
          }
        }
        if (changes.length > 0) resolvedDeps.invalidateModelCache();
        return { added, updated, removed };
      });
    },
  };
}
