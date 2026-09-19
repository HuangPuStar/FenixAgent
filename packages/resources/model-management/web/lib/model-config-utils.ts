import type { ModelEntry } from "@/src/types/config";
import { getModelProviderKey } from "./provider-resource-access";

/** 提取运行时模型名称中的 Peri 别名，其他名称保持原样。 */
export function simplifyModelDisplayName(modelName: string): string {
  const periAlias = modelName.match(/\((peri-[^)]+)\)\s*$/i)?.[1]?.trim();
  return periAlias || modelName;
}

/**
 * 将模型列表转换为下拉选择器的 option 数组。
 * 标签格式：${归属组织?/}${provider显示名}/${模型显示名}
 * 值格式：${scope.organizationId}/${providerId}/${modelId} 或 ${provider}/${modelId}（键不可推导时退化）
 *
 * 跨组织 Provider 无法仅凭配置名解析，因此值必须携带 Provider 的资源键；归属键统一由
 * `getModelProviderKey` 推导（模型不独立持有归属，一律取自所属 Provider）。
 */
export function buildModelOptions(available: ModelEntry[]): { value: string; label: string }[] {
  return available.map((model) => {
    const source = model.organizationName;
    const providerLabel = source ? `${source}/${model.providerDisplayName}` : model.providerDisplayName;
    return {
      value: `${getModelProviderKey(model)}/${model.modelId}`,
      label: `${providerLabel}/${model.displayName}`,
    };
  });
}
