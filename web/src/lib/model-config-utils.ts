import type { ModelEntry } from "../types/config";

/**
 * 将模型列表转换为下拉选择器的 option 数组。
 * 标签格式：${来源组织?/}${provider显示名}/${模型显示名}
 * 值格式：${providerResourceKey}/${modelId} 或 ${provider}/${modelId}（兼容旧数据）
 */
export function buildModelOptions(available: ModelEntry[]): { value: string; label: string }[] {
  return available.map((model) => {
    const source = model.providerResourceAccess?.sourceOrganizationName;
    const providerLabel = source ? `${source}/${model.providerDisplayName}` : model.providerDisplayName;
    return {
      value: model.providerResourceKey
        ? `${model.providerResourceKey}/${model.modelId}`
        : `${model.provider}/${model.modelId}`,
      label: `${providerLabel}/${model.displayName}`,
    };
  });
}
