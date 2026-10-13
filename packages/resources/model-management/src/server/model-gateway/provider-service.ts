import { error as logError } from "@fenix/logger";
import type { GatewayModel, ModelGatewayAdapter } from "@fenix/model-gateway-sdk";
import type { AccessControlModule, ActorContext, ResourceQueryConstraint, SystemTenant } from "@fenix/platform-sdk";
// 系统托管租户经 platform-sdk 的只读窄契约取得：resource 类别不得依赖 platform-impl（identity）。
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import { providerResource } from "../access/provider-resource";
import { getModelManagementModule } from "../module-runtime";
import type { ModelRepository, ModelRow } from "../repositories/model-resource";
import { withModelSyncLock as defaultModelSyncLock } from "../repositories/model-sync-lock";
import type { ProviderWriteData } from "../repositories/provider-resource";
import type { ProviderService } from "../services/provider-service";

/**
 * 系统模型网关 Provider 的编排。
 *
 * 这是**系统路径**：没有请求 actor，动作的归属主体是系统托管租户（见 {@link systemActor}）。它绕过
 * Facade 直接调用领域服务与子表仓储，理由有两条：
 *
 * 1. Facade 会对 `kind === "gateway"` 的行抛出"由系统管理"的拒绝（那正是用户请求路径要的行为），
 *    系统维护路径必须能改它；
 * 2. 系统路径不存在"当前主体"，把系统租户伪装成一次用户请求只会让授权的两个来源互相掩盖。
 *
 * 但它并不因此绕过授权：所有受控读取都用系统租户主体的 `createListConstraint` 条件，创建时显式写入
 * `visibility: "public"`（系统网关是全体已认证用户使用模型的唯一入口）。Provider 是 Fenix 的公开
 * 消费投影，所有上游管理凭证都保留在 Adapter 配置中，因此这里明确写入空 `apiKey`，避免把 LiteLLM
 * Master Key 暴露给 Agent。
 */

export const SYSTEM_MODEL_GATEWAY_PROVIDER_NAME = "fenix-model-gateway";

/**
 * 请求路径上「这个 Provider 对当前调用者不可见」的专用失败。
 *
 * 与「网关配置/上游故障」分开成类是有意的语义区分：不可见由授权谓词决定，是**确定性**结果——重试必然
 * 得到同一答案；上游超时、适配器报错才可能自愈。控制台用量页据此二分（`/web/model-gateway/:providerId/
 * usage` 把它映射为 403，其余保持 400），否则用户会对着一个永远失败的重试按钮反复点击。
 */
export class ModelGatewayProviderNotVisibleError extends Error {
  constructor(providerId: string) {
    super(`model gateway provider '${providerId}' is not visible to the caller`);
    this.name = "ModelGatewayProviderNotVisibleError";
  }
}

export interface SystemModelGatewayProviderOptions {
  baseUrl: string;
  gatewayType: string;
  displayName?: string;
}

/**
 * 编排依赖；`service` / `models` / `accessControl` 默认取自已装配的资源模块，测试可整体替换。
 *
 * 默认值是惰性求值的：模块尚未装配时构造本服务不会立刻抛错（`main.ts` 的模型网关初始化早于任何
 * 用户请求，但测试会用自己的替身构造）。
 */
interface ProviderServiceDeps {
  resolveSystemTenant: () => Promise<SystemTenant>;
  service: ProviderService;
  models: ModelRepository;
  accessControl: AccessControlModule;
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
 * 系统网关请求的主体：系统托管租户的 owner。
 *
 * 不使用 `systemRole: "super-admin"`：按决策 D8 当前没有任何生产赋值点，那条契约分支只保留给系统
 * 管理形态确定后的扩展。系统租户的 owner 成员关系已经覆盖它对**自身组织**内资源的全部动作，因此
 * 这里不需要任何越过归属的特权。
 *
 * `memberships` 显式给出"系统租户 + owner"这一条即可：授权只会取当前组织那一条，而这里的
 * active organization 就是系统租户本身。这个主体只代表系统租户内的操作，不承载其他组织的身份。
 */
function systemActor(tenant: SystemTenant): ActorContext {
  return {
    kind: "user",
    userId: tenant.userId,
    activeOrganizationId: tenant.organizationId,
    memberships: [{ organizationId: tenant.organizationId, role: "owner" }],
  };
}

export function createSystemModelGatewayProviderService(
  deps: Partial<ProviderServiceDeps> = {},
  options: SystemModelGatewayProviderOptions,
) {
  if (!options) throw new Error("model gateway provider options are required");
  if (!options.baseUrl.trim()) throw new Error("model gateway provider baseUrl is required");
  if (!options.gatewayType.trim()) throw new Error("model gateway provider gatewayType is required");

  const resolveSystemTenant = deps.resolveSystemTenant ?? (() => getIdentityDirectory().resolveSystemTenant());
  const service = () => deps.service ?? getModelManagementModule().service;
  const models = () => deps.models ?? getModelManagementModule().models;
  const accessControl = () => deps.accessControl ?? getModelManagementModule().accessControl;
  const facade = () => getModelManagementModule().facade;
  const invalidateModelCache = deps.invalidateModelCache ?? (() => {});
  // 缺省锁实现来自仓储层（跨实例 advisory lock）；测试注入可直接放行的替身。
  const withModelSyncLock = deps.withModelSyncLock ?? defaultModelSyncLock;

  /** 系统主体 + 它在该资源上的读取条件；两者必须成对使用，分开获取会让条件对不上主体。 */
  async function systemContext(): Promise<{
    tenant: SystemTenant;
    actor: ActorContext;
    access: ResourceQueryConstraint;
  }> {
    const tenant = await resolveSystemTenant();
    const actor = systemActor(tenant);
    const access = await accessControl().createListConstraint({
      actor,
      action: "read",
      resource: providerResource.definition,
    });
    return { tenant, actor, access };
  }

  function getAdapter() {
    if (!deps.adapter) throw new Error("model gateway adapter is not configured");
    return deps.adapter;
  }

  /** 按名读取系统网关 Provider；同组织同名是唯一索引约束，因此至多一行。 */
  async function findGatewayProvider(access: ResourceQueryConstraint, tenant: SystemTenant) {
    return service().findByName({
      access,
      name: SYSTEM_MODEL_GATEWAY_PROVIDER_NAME,
      organizationId: tenant.organizationId,
    });
  }

  function toSummary(
    tenant: SystemTenant,
    row: { id: string; name: string; displayName: string | null; gatewayType: string | null; baseUrl: string | null },
    modelCount: number,
  ): ModelGatewayProviderSummary {
    return {
      id: row.id,
      name: row.name,
      displayName: row.displayName ?? SYSTEM_MODEL_GATEWAY_PROVIDER_NAME,
      gatewayType: row.gatewayType ?? options.gatewayType,
      baseUrl: row.baseUrl,
      modelCount,
      owner: { email: tenant.email, organizationSlug: tenant.organizationSlug },
    };
  }

  /** Gateway Provider 的可写配置；创建与同步共用，保证两条路径写出的字段集合一致。 */
  function gatewayWriteData(): ProviderWriteData {
    return {
      displayName: options.displayName ?? "全局模型网关",
      kind: "gateway",
      gatewayType: options.gatewayType,
      protocol: "openai",
      baseUrl: options.baseUrl,
      apiKey: null,
    };
  }

  /** 读取网关 Provider 行与两侧模型清单（本地投影 + 上游），是 check / sync 的共同前置。 */
  async function readGateway(providerId: string) {
    const { tenant, access } = await systemContext();
    const providerRow = await service().findById({ access, resourceId: providerId });
    if (providerRow?.kind !== "gateway") throw new Error("model gateway provider not found");
    if (providerRow.gatewayType !== options.gatewayType) throw new Error("model gateway type mismatch");
    return {
      tenant,
      providerRow,
      localModels: await models().listByProviderId({ providerId }),
      remoteModels: await getAdapter().listModels(),
    };
  }

  /** 确保系统网关 Provider 存在，返回它的资源 ID。 */
  async function ensureProvider(): Promise<string> {
    const { tenant, access } = await systemContext();
    const existing = await findGatewayProvider(access, tenant);
    if (existing) {
      if (existing.kind !== "gateway") throw new Error("system model gateway provider has an invalid kind");
      return existing.id;
    }

    const resourceId = await service().create({
      name: SYSTEM_MODEL_GATEWAY_PROVIDER_NAME,
      data: gatewayWriteData(),
      organizationId: tenant.organizationId,
      ownerUserId: tenant.userId,
      // 系统网关必须对全体已认证用户可读：它是 Agent 使用模型的唯一入口。归属仍留在系统租户，
      // `visibility` 只放开 read，不放开 update / delete。
      visibility: "public",
    });
    if (resourceId === undefined) throw new Error("system model gateway provider could not be persisted");
    return resourceId;
  }

  function diffModels(existing: readonly ModelRow[], remote: GatewayModel[]) {
    const existingById = new Map(existing.map((item) => [item.modelId, item]));
    const remoteById = new Map(remote.map((item) => [item.id, item]));
    const changes: ModelSyncChange[] = [];
    for (const item of remote) {
      const current = existingById.get(item.id);
      const displayName = item.displayName ?? item.id;
      if (!current) changes.push({ modelId: item.id, kind: "added", displayName });
      else if (current.displayName !== displayName) {
        changes.push({ modelId: item.id, kind: "updated", displayName });
      }
    }
    for (const item of existing) {
      if (!remoteById.has(item.modelId)) {
        changes.push({ modelId: item.modelId, kind: "removed", displayName: item.displayName ?? item.modelId });
      }
    }
    return changes;
  }

  return {
    /**
     * 返回当前调用者可读取的指定 Gateway Provider 摘要，供 Provider 上下文页面使用。
     *
     * 这是**用户请求路径**：授权经 Facade 的受控读取完成，`actor` 必须是真实请求主体（宿主从
     * `store.actor` 注入），不得传系统主体——那会让任何调用者都读得到系统租户的资源。
     *
     * 两种失败刻意不同：Facade 读不到行（不存在或超出可见范围）抛
     * {@link ModelGatewayProviderNotVisibleError}（确定性权限结果，路由映射 403）；读到了行但它不是本
     * 网关类型抛普通错误（网关配置类故障，路由保持 400）。
     */
    async getProviderForUsage(actor: ActorContext, providerId: string) {
      const provider = await facade().getById(actor, providerId);
      if (!provider) throw new ModelGatewayProviderNotVisibleError(providerId);
      if (provider.kind !== "gateway" || provider.gatewayType !== options.gatewayType) {
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
      const { tenant, access } = await systemContext();
      const providerRow = await findGatewayProvider(access, tenant);
      if (providerRow?.kind !== "gateway") return { provider: null };
      const localModels = await models().listByProviderId({ providerId: providerRow.id });
      return { provider: toSummary(tenant, providerRow, localModels.length) };
    },
    /** 获取现有系统 Provider，不更新其配置，用于检查配置差异。 */
    getProviderForCheck: () => ensureProvider(),
    ensureProvider,
    async checkModels(providerId: string): Promise<ModelSyncCheckResult> {
      try {
        const { tenant, providerRow, localModels, remoteModels } = await readGateway(providerId);
        const changes = diffModels(localModels, remoteModels);
        const providerBaseUrlChanged = providerRow.baseUrl !== options.baseUrl;
        return {
          status: changes.length > 0 || providerBaseUrlChanged ? "pending" : "synced",
          changes,
          models: remoteModels,
          provider: toSummary(tenant, providerRow, localModels.length),
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
      return withModelSyncLock(async () => {
        const { providerRow, localModels, remoteModels } = await readGateway(providerId);

        // 配置变更在同步动作中落库，检查动作保持只读，避免掩盖待同步状态。
        if (providerRow.baseUrl !== options.baseUrl) {
          const updated = await service().update({ resourceId: providerRow.id, data: gatewayWriteData() });
          if (!updated) throw new Error("model gateway provider not found");
        }

        const changes = diffModels(localModels, remoteModels);
        let added = 0;
        let updated = 0;
        let removed = 0;
        for (const change of changes) {
          const scope = { organizationId: providerRow.organizationId, providerId };
          if (change.kind === "added") {
            await models().upsert({
              ...scope,
              modelId: change.modelId,
              data: { displayName: change.displayName },
            });
            added += 1;
          } else if (change.kind === "updated") {
            await models().updateByModelId({
              ...scope,
              modelId: change.modelId,
              data: { displayName: change.displayName },
            });
            updated += 1;
          } else {
            await models().removeByModelId({ ...scope, modelId: change.modelId });
            removed += 1;
          }
        }
        if (changes.length > 0) invalidateModelCache();
        return { added, updated, removed };
      });
    },
  };
}
