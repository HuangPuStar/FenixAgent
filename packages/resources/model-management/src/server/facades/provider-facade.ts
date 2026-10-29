import {
  type ActorContext,
  AuthorizedResourceFacade,
  type AuthorizedResourceFacadeOptions,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ResourceAccessDeniedError,
  type ResourceAction,
} from "@fenix/platform-sdk";
import type { ModelRepository, ModelRow, ModelWriteData } from "../repositories/model-resource";
import { PROVIDER_LIST_ORDER, type ProviderWriteData, type ScopedProviderRow } from "../repositories/provider-resource";

/**
 * Provider 的资源应用 Facade：授权编排 + 「Model 跟随 Provider」的跨资源编排。
 *
 * 它是 Provider 与其 Model 子表的**唯一**应用入口（`route → Facade → Domain Service → Repository`）：
 * route 只做协议接入与响应映射，route 不持有授权判断，领域服务不认识 actor。所有授权判断都经
 * `AccessControlModule`（继承基类的 `resolveInitialScope` / `listConstraint` / `authorizeAction` /
 * `withAccess*` / `setVisibility`），本文件不复制任何组织、角色或 `visibility` 规则。
 *
 * **Model 为什么没有自己的 Domain Service**（决策 D6 + Q1）：Model 不注册独立资源、不建 owner /
 * `visibility`，也没有任何"跟随父资源"以外的领域规则——它的全部行为就是"先对 Provider 授权，再按
 * `provider_id` 读写子行"。为它加一层只做转发的服务会制造一个空层，因此这里直接依赖
 * {@link ModelRepository}，并在每个子表方法上显式写出"第一步先对 Provider 授权"。
 *
 * 平台抛出的 {@link ResourceAccessDeniedError} 在这里映射为对外 403，其余错误原样上抛：存储或装配
 * 故障不得被伪装成权限问题。
 */

/** 系统网关 Provider 的两种拒绝文案：`/web` 与 `/api` 的已有响应文本，保持不变。 */
const GATEWAY_PROVIDER_MESSAGE = "Gateway Provider is managed by the system";
const GATEWAY_MODEL_MESSAGE = "Gateway Provider models are managed by the system";

import type {
  AuthorizedProviderDetail,
  AuthorizedProviderListItem,
  AuthorizedProviderModelsPage,
  ModelRef,
  ProviderFacadeApi,
  ProviderFacadeDeps,
  ProviderModelWriteResult,
  ProviderRef,
  ProviderWriteOptions,
} from "./provider-facade-types";

export type {
  AuthorizedProvider,
  AuthorizedProviderDetail,
  AuthorizedProviderListItem,
  AuthorizedProviderModelsPage,
  ModelRef,
  ProviderFacadeApi,
  ProviderFacadeDeps,
  ProviderModelWriteResult,
  ProviderRef,
  ProviderWriteOptions,
} from "./provider-facade-types";

export class ProviderFacade extends AuthorizedResourceFacade implements ProviderFacadeApi {
  constructor(
    private readonly deps: ProviderFacadeDeps,
    options: AuthorizedResourceFacadeOptions,
  ) {
    super(options);
  }

  /** 列表：授权谓词、业务排序与分页都下推到 SQL；`total` 与 `items` 共用同一可见集合。 */
  async list(
    actor: ActorContext,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ items: AuthorizedProviderListItem[]; total: number }> {
    const access = await this.listConstraint(actor, "read");
    const { items, total } = await this.deps.service.list({
      access,
      order: PROVIDER_LIST_ORDER,
      ...options,
    });
    const authorized = await this.withAccessMany(actor, items);
    const counts = await this.deps.models.countByProviderIds({ providerIds: items.map((item) => item.id) });
    return {
      items: authorized.map((item) => ({ ...item, modelCount: counts.get(item.id) ?? 0 })),
      total,
    };
  }

  async get(actor: ActorContext, nameOrKey: string): Promise<AuthorizedProviderDetail | undefined> {
    const row = await this.findVisible(actor, nameOrKey);
    return row ? this.toDetail(actor, row) : undefined;
  }

  async getById(actor: ActorContext, resourceId: string): Promise<AuthorizedProviderDetail | undefined> {
    const access = await this.listConstraint(actor, "read");
    const row = await this.deps.service.findById({ access, resourceId });
    return row ? this.toDetail(actor, row) : undefined;
  }

  /**
   * 名称入口的幂等保存。
   *
   * 已存在的行先取 `update` 动作再写：跨组织公开的 Provider 只拿到 `read`，因此"外部只读"由授权
   * 谓词自然表达，不需要另写一条 `writable === false` 的判断。不存在的名字走创建路径，`create`
   * 判定与初始归属由 `resolveInitialScope` 在同一步给出。
   */
  async getForProbe(actor: ActorContext, ref: ProviderRef): Promise<AuthorizedProviderDetail | undefined> {
    const row = await this.resolveVisible(actor, ref);
    if (!row) return;
    // 刻意不在这里拒绝 gateway：探测不改配置，见接口文档。
    await this.requireAction(actor, "update", row.id);
    return this.toDetail(actor, row);
  }

  async getWritable(actor: ActorContext, ref: ProviderRef): Promise<AuthorizedProviderDetail> {
    const row = await this.requireWritableProvider(actor, ref);
    return this.toDetail(actor, row);
  }

  async save(
    actor: ActorContext,
    name: string,
    data: ProviderWriteData,
    options: ProviderWriteOptions = {},
  ): Promise<AuthorizedProviderDetail> {
    const existing = await this.findVisible(actor, name);
    if (existing) {
      await this.requireUserManaged(existing, GATEWAY_PROVIDER_MESSAGE);
      await this.requireAction(actor, "update", existing.id);
      await this.write(actor, existing.id, data, options, name);
      return this.reload(actor, existing.id, name);
    }

    const scope = await this.resolveCreateScope(actor);
    if (scope.organizationId === undefined) {
      throw new Error("Provider 归属组织缺失：组织资源必须落在某个组织上");
    }
    const resourceId = await this.deps.service.create({
      name,
      data,
      organizationId: scope.organizationId,
      ownerUserId: scope.ownerUserId ?? actor.userId,
      visibility: options.publicReadable === true ? "public" : scope.visibility,
    });
    if (resourceId === undefined) {
      throw new Error("Provider 创建未返回资源 ID");
    }
    return this.reload(actor, resourceId, name);
  }

  /** 控制台创建使用 INSERT 冲突拒绝，防止并发覆盖已有配置。 */
  async create(
    actor: ActorContext,
    name: string,
    data: ProviderWriteData,
    options: ProviderWriteOptions = {},
  ): Promise<AuthorizedProviderDetail> {
    const scope = await this.resolveCreateScope(actor);
    if (scope.organizationId === undefined) {
      throw new Error("Provider 归属组织缺失：组织资源必须落在某个组织上");
    }
    const resourceId = await this.deps.service.create({
      name,
      data,
      rejectConflict: true,
      organizationId: scope.organizationId,
      ownerUserId: scope.ownerUserId ?? actor.userId,
      visibility: options.publicReadable === true ? "public" : scope.visibility,
    });
    if (resourceId === undefined) {
      throw new ConflictError(`Provider '${name}' already exists`);
    }
    return this.reload(actor, resourceId, name);
  }

  /** 资源 ID 入口的更新：由管理接口使用，语义与名称入口的"更新分支"完全一致。 */
  async saveById(
    actor: ActorContext,
    resourceId: string,
    data: ProviderWriteData,
    options: ProviderWriteOptions = {},
  ): Promise<AuthorizedProviderDetail> {
    const row = await this.requireVisible(actor, { by: "resourceId", value: resourceId });
    await this.requireUserManaged(row, GATEWAY_PROVIDER_MESSAGE);
    await this.requireAction(actor, "update", row.id);
    await this.write(actor, row.id, data, options, resourceId);
    return this.reload(actor, row.id, resourceId);
  }

  /** 删除资源行；`model` 子表由外键 `ON DELETE CASCADE` 一并清理。 */
  async remove(actor: ActorContext, ref: ProviderRef): Promise<void> {
    const row = await this.requireVisible(actor, ref);
    await this.requireUserManaged(row, GATEWAY_PROVIDER_MESSAGE);
    await this.requireAction(actor, "delete", row.id);

    const deleted = await this.deps.service.remove({ resourceId: row.id });
    if (!deleted) throw new NotFoundError(`Provider '${ref.value}' not found`);
  }

  /**
   * `total` 与 `items` 来自同一个可见集合：子行没有独立授权（决策 D6），Provider 可见即其全部子行可读，
   * 因此计数与分页查询共用同一个 `provider_id` 条件，不存在"计数把不可见子行算进去"的可能。
   */
  async listModels(
    actor: ActorContext,
    ref: ProviderRef,
    options: { limit?: number; offset?: number } = {},
  ): Promise<AuthorizedProviderModelsPage | undefined> {
    const row = await this.resolveVisible(actor, ref);
    if (!row) return;

    const authorized = await this.withAccess(actor, row);
    const items = await this.deps.models.listByProviderId({ providerId: row.id, ...options });
    const counts = await this.deps.models.countByProviderIds({ providerIds: [row.id] });
    return { ...authorized, items, total: counts.get(row.id) ?? 0 };
  }

  /**
   * 新增 Model 子行。
   *
   * 重复 `modelId` 的判定刻意留在 route：`/web` 与 `/api` 对同一情形返回不同的错误码与文案
   * （`VALIDATION_ERROR` 与 `409 CONFLICT`），而错误码是协议细节，不属于领域规则。仓储侧是幂等
   * upsert，因此即使两个请求同时通过检查也只会收敛到同一行，不会产生重复子行。
   */
  async addModel(
    actor: ActorContext,
    ref: ProviderRef,
    modelId: string,
    data: ModelWriteData,
  ): Promise<ProviderModelWriteResult> {
    const provider = await this.requireWritableProvider(actor, ref);
    const created = await this.deps.models.upsert({
      providerId: provider.id,
      organizationId: provider.organizationId,
      modelId,
      data,
    });
    if (created === undefined) {
      throw new Error("Model 创建未返回资源 ID");
    }
    return { id: created, provider: await this.reload(actor, provider.id, ref.value), modelId };
  }

  async updateModel(
    actor: ActorContext,
    ref: ProviderRef,
    modelRef: ModelRef,
    data: ModelWriteData,
  ): Promise<ProviderModelWriteResult> {
    const provider = await this.requireWritableProvider(actor, ref);
    const model = await this.requireModel(provider.id, modelRef);

    const updated =
      modelRef.by === "id"
        ? await this.deps.models.updateById({
            organizationId: provider.organizationId,
            providerId: provider.id,
            id: modelRef.value,
            data,
          })
        : await this.deps.models.updateByModelId({
            organizationId: provider.organizationId,
            providerId: provider.id,
            modelId: modelRef.value,
            data,
          });
    if (!updated) throw new NotFoundError(`Model '${modelRef.value}' not found`);

    return { id: model.id, provider: await this.reload(actor, provider.id, ref.value), modelId: model.modelId };
  }

  async removeModel(actor: ActorContext, ref: ProviderRef, modelRef: ModelRef): Promise<ProviderModelWriteResult> {
    const provider = await this.requireWritableProvider(actor, ref);
    const model = await this.requireModel(provider.id, modelRef);

    const deleted =
      modelRef.by === "id"
        ? await this.deps.models.removeById({
            organizationId: provider.organizationId,
            providerId: provider.id,
            id: modelRef.value,
          })
        : await this.deps.models.removeByModelId({
            organizationId: provider.organizationId,
            providerId: provider.id,
            modelId: modelRef.value,
          });
    if (!deleted) throw new NotFoundError(`Model '${modelRef.value}' not found`);

    return { id: model.id, provider: await this.reload(actor, provider.id, ref.value), modelId: model.modelId };
  }

  /** 可见性解析：名称按"当前组织优先"匹配，资源键解析归属组织并由查询校验一致。 */
  private async findVisible(actor: ActorContext, nameOrKey: string): Promise<ScopedProviderRow | undefined> {
    const access = await this.listConstraint(actor, "read");
    if (nameOrKey.includes("/")) {
      return this.deps.service.findByResourceKey({ access, resourceKey: nameOrKey });
    }
    const activeOrganizationId = actor.activeOrganizationId;
    if (activeOrganizationId !== undefined) {
      const internal = await this.deps.service.findByName({
        access,
        name: nameOrKey,
        organizationId: activeOrganizationId,
      });
      if (internal) return internal;
    }
    return this.deps.service.findByName({ access, name: nameOrKey });
  }

  /** 可见性解析：资源 ID 或名称/资源键两条入口共用同一份 `read` 条件；不可见返回 `undefined`。 */
  private async resolveVisible(actor: ActorContext, ref: ProviderRef): Promise<ScopedProviderRow | undefined> {
    return ref.by === "resourceId"
      ? this.deps.service.findById({ access: await this.listConstraint(actor, "read"), resourceId: ref.value })
      : this.findVisible(actor, ref.value);
  }

  private async requireVisible(actor: ActorContext, ref: ProviderRef): Promise<ScopedProviderRow> {
    const row = await this.resolveVisible(actor, ref);
    if (!row) throw new NotFoundError(`Provider '${ref.value}' not found`);
    return row;
  }

  /** 子表写路径的公共前置：可见 → 非系统托管 → 拿到 Provider 的 `update` 动作。 */
  private async requireWritableProvider(actor: ActorContext, ref: ProviderRef): Promise<ScopedProviderRow> {
    const row = await this.requireVisible(actor, ref);
    await this.requireUserManaged(row, GATEWAY_MODEL_MESSAGE);
    await this.requireAction(actor, "update", row.id);
    return row;
  }

  /** 定位子行；不存在或不属于该 Provider 都按"找不到"处理，不泄露其它 Provider 的子行存在性。 */
  private async requireModel(providerId: string, modelRef: ModelRef): Promise<ModelRow> {
    const row =
      modelRef.by === "id"
        ? await this.deps.models.findById({ providerId, id: modelRef.value })
        : await this.deps.models.findByModelId({ providerId, modelId: modelRef.value });
    if (!row) throw new NotFoundError(`Model '${modelRef.value}' not found`);
    return row;
  }

  /** 写配置与公开受众；公开受众变更由 {@link AuthorizedResourceFacade.setVisibility} 再校验一次。 */
  private async write(
    actor: ActorContext,
    resourceId: string,
    data: ProviderWriteData,
    options: ProviderWriteOptions,
    label: string,
  ): Promise<void> {
    const updated = await this.deps.service.update({ resourceId, data });
    if (!updated) throw new NotFoundError(`Provider '${label}' not found`);

    if (options.publicReadable !== undefined) {
      await this.setVisibility(actor, resourceId, options.publicReadable ? "public" : "private");
    }
  }

  private async toDetail(actor: ActorContext, row: ScopedProviderRow): Promise<AuthorizedProviderDetail> {
    const authorized = await this.withAccess(actor, row);
    const models = await this.deps.models.listByProviderId({ providerId: row.id });
    return { ...authorized, models };
  }

  /**
   * 写路径回读：按 ID 走受控读取，避免"按名称再查一次"命中另一个同名资源。
   *
   * 刻意不用 `findRowUnscoped` + `withAccess`：归属范围必须由授权查询产出（谓词就是从归属列推导的），
   * 绕过查询自己拼 scope 会让"行的归属"与"授权看到的归属"出现两条来源。
   */
  private async reload(actor: ActorContext, resourceId: string, label: string): Promise<AuthorizedProviderDetail> {
    const authorized = await this.getById(actor, resourceId);
    if (!authorized) throw new NotFoundError(`Provider '${label}' not found`);
    return authorized;
  }

  /**
   * 系统网关 Provider 由启动流程与懒调用维护（见 `../model-gateway/provider-service.ts`），
   * 用户请求路径不得改写它。
   *
   * 这是**状态校验**而不是授权判断：它与访问者是谁无关，因此留在 Facade 而不下沉到领域服务——
   * 领域服务不认识 actor，也无从知道"用户请求"与"系统初始化"的区别。
   */
  private requireUserManaged(row: { readonly kind: string }, message: string): void {
    if (row.kind === "gateway") throw new ForbiddenError(message);
  }

  /** 把平台的授权拒绝映射为对外 403；其它错误保持原样，避免把故障伪装成权限问题。 */
  private async requireAction(actor: ActorContext, action: ResourceAction, resourceId: string): Promise<void> {
    try {
      await this.authorizeAction(actor, action, resourceId);
    } catch (error) {
      if (error instanceof ResourceAccessDeniedError) throw new ForbiddenError(error.message);
      throw error;
    }
  }

  private async resolveCreateScope(actor: ActorContext): Promise<{
    organizationId?: string;
    ownerUserId?: string;
    visibility: "private" | "public";
  }> {
    try {
      return await this.resolveInitialScope(actor);
    } catch (error) {
      if (error instanceof ResourceAccessDeniedError) throw new ForbiddenError(error.message);
      throw error;
    }
  }
}
