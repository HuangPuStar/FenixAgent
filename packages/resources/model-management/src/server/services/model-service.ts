import type { ModelRepository, ModelRow } from "../repositories/model-resource";
import type { ProviderRepository, ProviderRow } from "../repositories/provider-resource";

/**
 * Model 侧领域服务：为"启动一个 Agent 需要哪个模型"提供无授权读取。
 *
 * 为什么单列一个服务，而不是让消费方各取一个仓储：
 * - 该流程要同时读 `provider` 与 `model` 两张表，并把"组织内第一个可用模型"这条**业务规则**（排序键、
 *   provider 无模型时跳过）表达一次。规则留在本包，消费方只表达"要一个可用的"，两侧排序才不会分叉。
 * - 命名里的 `Unscoped` 与各仓储同义：绕过授权谓词，只允许系统路径调用（launch spec 构建、模型网关
 *   provider 同步）。**不做任何用户授权判断**——按 §2.2，领域服务不接受 actor；用户请求路径走
 *   `ProviderFacade`（先对 Provider 授权，再操作子表）。
 *
 * 仓储由调用方（宿主装配层）注入：本包不持有进程级单例，一次装配产出一个实例集。
 */
export interface ModelServiceDeps {
  readonly modelRepository: ModelRepository;
  readonly providerRepository: ProviderRepository;
}

/** 组织内第一个可用模型及其所属 Provider。 */
export interface FirstConfiguredModel {
  readonly provider: ProviderRow;
  readonly model: ModelRow;
}

export interface ModelService {
  /** 无授权按主键读取模型行；调用方负责比对缺失（launch spec 构建据此报"引用了不存在的模型"）。 */
  findModelRowUnscoped(resourceId: string): Promise<ModelRow | undefined>;
  /** 无授权按 (组织, Provider ID) 读取 Provider 行；组织条件用于拒绝模型行与 Provider 行跨组织的脏数据。 */
  findProviderRowUnscoped(input: { providerId: string; organizationId: string }): Promise<ProviderRow | undefined>;
  /**
   * 无授权取组织内"第一个已配置模型"。
   *
   * 按 `PROVIDER_LIST_ORDER` 枚举组织内 Provider，取每个 Provider 下按 `MODEL_LIST_ORDER` 排第一的模型；
   * 没有任何 Provider 配了模型时返回 undefined（由调用方决定失败语义：无 AgentConfig 的最小启动路径
   * 会据此报"请先配置模型"）。
   */
  findFirstConfiguredByOrganizationUnscoped(organizationId: string): Promise<FirstConfiguredModel | undefined>;
}

export function createModelService(deps: ModelServiceDeps): ModelService {
  return {
    findModelRowUnscoped(resourceId) {
      return deps.modelRepository.findRowUnscoped({ id: resourceId });
    },

    findProviderRowUnscoped(input) {
      return deps.providerRepository.findRowByOrganizationUnscoped({
        resourceId: input.providerId,
        organizationId: input.organizationId,
      });
    },

    async findFirstConfiguredByOrganizationUnscoped(organizationId) {
      const providers = await deps.providerRepository.listByOrganizationUnscoped({ organizationId });
      for (const provider of providers) {
        // 逐个 Provider 取首个模型：空 Provider 不能中断枚举，否则"第一个 Provider 恰好没配模型"
        // 会让后面配好的 Provider 永远选不上。
        const model = await deps.modelRepository.findFirstByProviderUnscoped({ providerId: provider.id });
        if (model) return { provider, model };
      }
      // 枚举结束后自然返回 undefined：没有任何 Provider 配了模型，由调用方决定失败语义。
    },
  };
}
