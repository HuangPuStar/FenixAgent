import type { SecretReferenceResolver } from "../../../config-envelope";
import { toKeyHint } from "../../../config-envelope";
import type { AuthorizedProviderDetail, AuthorizedProviderListItem } from "../../../facades/provider-facade";

/**
 * Provider 的控制台视图投影。
 *
 * 字段名与迁移前逐字一致；`scope` / `access` 直接透传 Facade 的产物，不做任何改写——它们是当前主体
 * 在这一份资源上的归属与动作事实，前端的"能否编辑"必须由 `access.actions` 判定，不允许另起一套推断。
 *
 * `keyHint` 需要解析密钥引用（库里可能是 `{env:NAME}`），解析器由调用方传入：包内不得读 `process.env`。
 */

/** 列表项视图。 */
export function toWebProviderListItem(
  provider: AuthorizedProviderListItem,
  resolveSecretReference: SecretReferenceResolver,
) {
  return {
    // TODO(model-gateway): 统一 Provider 列表契约为 id=UUID、name=配置名、displayName=展示名，
    // 并同步迁移仍依赖 id=配置名的配置接口调用方；届时删除 providerId 过渡字段。
    providerId: provider.id,
    id: provider.name,
    name: provider.displayName ?? "",
    kind: provider.kind,
    gatewayType: provider.gatewayType,
    protocol: provider.protocol,
    keyHint: toKeyHint(provider.apiKey, resolveSecretReference),
    baseURL: provider.baseUrl ?? null,
    modelCount: provider.modelCount,
    scope: provider.scope,
    access: provider.access,
  };
}

/**
 * `options` 是自由形状的 jsonb 列：非对象（含数组）一律投影为 `null`。
 *
 * 判据与 `/api/models` 的 `toModelDetail` 逐字一致——同一列在两条路由上不能给出两种形状。前端读它
 * 回显「启用思考模式」开关，并按子键合并写回，缺这一列会让开关永远显示为关。
 */
function toModelOptions(options: unknown): Record<string, unknown> | null {
  if (options === null || typeof options !== "object" || Array.isArray(options)) return null;
  return options as Record<string, unknown>;
}

/**
 * 详情视图。
 *
 * `label` 是调用方用来定位这份配置的名称或资源键，与列表项的 `id` 同义（用户看到的是配置名）。
 * 子模型不再携带 `providerResourceAccess`：模型的可访问性完全继承 Provider（决策 D6），逐行重复
 * 一份继承来的判定只会制造"两者可能不一致"的假象。
 */
export function toWebProviderDetail(
  detail: AuthorizedProviderDetail,
  label: string,
  resolveSecretReference: SecretReferenceResolver,
) {
  return {
    id: label,
    name: detail.displayName ?? "",
    kind: detail.kind,
    gatewayType: detail.gatewayType,
    protocol: detail.protocol,
    keyHint: toKeyHint(detail.apiKey, resolveSecretReference),
    baseURL: detail.baseUrl ?? null,
    scope: detail.scope,
    access: detail.access,
    models: detail.models.map((model) => ({
      id: model.modelId,
      name: model.displayName ?? model.modelId,
      modalities: model.modalities ?? null,
      limit: model.limitConfig ?? null,
      cost: model.cost ?? null,
      options: toModelOptions(model.options),
    })),
  };
}
