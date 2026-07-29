// packages/acp-server/src/config-options.ts
// 从 ACP agent status/configOptions 中提取 model/mode 选择状态。
// 纯函数，不依赖任何 I/O 或框架。

/** 从 configOptions 中提取模型选择状态（SDK 0.28+ 无独立 models 字段） */
export function extractModelStateFromConfigOptions(
  configOptions: Array<Record<string, unknown>> | undefined,
): { currentModelId: string; availableModels: Array<{ modelId: string; name: string }> } | null {
  if (!configOptions) return null;
  const modelOption = configOptions.find((o) => o.type === "select" && (o.id === "model" || o.category === "model"));
  if (!modelOption) return null;
  const rawOptions = modelOption.options as Array<Record<string, unknown>> | undefined;
  const flatOptions = flattenConfigOptions(rawOptions);
  const availableModels = flatOptions.map((o) => ({
    modelId: String(o.value ?? ""),
    name: String(o.name ?? ""),
  }));
  const rawCurrent = String(modelOption.currentValue ?? modelOption.value ?? "");
  const currentModelId = availableModels.some((m) => m.modelId === rawCurrent)
    ? rawCurrent
    : (availableModels[0]?.modelId ?? rawCurrent);
  return { currentModelId, availableModels };
}

/** 从 configOptions 中提取 mode 选择状态 */
export function extractModeStateFromConfigOptions(configOptions: Array<Record<string, unknown>> | undefined): {
  currentModeId: string;
  availableModes: Array<{ id: string; name: string; description?: string | null }>;
} | null {
  if (!configOptions) return null;
  const modeOption = configOptions.find((o) => o.type === "select" && (o.id === "mode" || o.category === "mode"));
  if (!modeOption) return null;
  const rawOptions = modeOption.options as Array<Record<string, unknown>> | undefined;
  const flatOptions = flattenConfigOptions(rawOptions);
  const availableModes = flatOptions.map((o) => ({
    id: String(o.value ?? ""),
    name: String(o.name ?? ""),
    description: (o.description as string) ?? null,
  }));
  const rawCurrent = String(modeOption.currentValue ?? modeOption.value ?? "");
  const currentModeId = availableModes.some((m) => m.id === rawCurrent)
    ? rawCurrent
    : (availableModes[0]?.id ?? rawCurrent);
  return { currentModeId, availableModes };
}

/** 拍平 configOptions 分组结构（兼容 group 嵌套） */
export function flattenConfigOptions(
  rawOptions: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> {
  if (!rawOptions) return [];
  const flat: Array<Record<string, unknown>> = [];
  for (const opt of rawOptions) {
    if ("group" in opt && Array.isArray(opt.options)) {
      flat.push(...(opt.options as Array<Record<string, unknown>>));
    } else {
      flat.push(opt);
    }
  }
  return flat;
}
