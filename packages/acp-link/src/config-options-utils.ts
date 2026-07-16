/**
 * 从 ACP session 的 configOptions 中提取模型选择状态。
 *
 * SDK 0.28.1 起 NewSessionResponse/LoadSessionResponse/ResumeSessionResponse 的
 * `models` 字段已移除，改用统一的 configOptions 机制承载模型列表和当前选择。
 * 本函数负责将 configOptions 格式转换为内部使用的 SessionModelState 格式。
 */
import type { ModelModalities, SessionModelState, SessionModeState } from "./types.js";

export function extractModelState(
  configOptions: Array<Record<string, unknown>> | null | undefined,
): SessionModelState | null {
  if (!configOptions) return null;

  // 通过 id 或 category 定位模型选项（不同 agent 实现可能只用其一）
  const modelOption = configOptions.find((o) => o.type === "select" && (o.id === "model" || o.category === "model"));
  if (!modelOption) return null;

  const flatOptions = flattenOptions(modelOption.options);

  return {
    currentModelId: String(modelOption.currentValue ?? modelOption.value ?? ""),
    availableModels: flatOptions.map((o) => ({
      modelId: String(o.value ?? ""),
      name: String(o.name ?? ""),
      description: (o.description as string) ?? null,
      modalities: (o.modalities as ModelModalities) ?? null,
    })),
  };
}

/**
 * 从 ACP session 的 configOptions 中提取 mode 选择状态。
 *
 * 部分引擎（如 Claude Code）把 mode 信息放在 configOptions 中
 * （category === "mode"），而不是用独立的 modes 字段。
 * 本函数负责将 configOptions 格式转换为内部使用的 SessionModeState 格式。
 */
export function extractModeState(
  configOptions: Array<Record<string, unknown>> | null | undefined,
): SessionModeState | null {
  if (!configOptions) return null;

  // 通过 id 或 category 定位 mode 选项（不同 agent 实现可能只用其一）
  const modeOption = configOptions.find((o) => o.type === "select" && (o.id === "mode" || o.category === "mode"));
  if (!modeOption) return null;

  const flatOptions = flattenOptions(modeOption.options);

  return {
    currentModeId: String(modeOption.currentValue ?? modeOption.value ?? ""),
    availableModes: flatOptions.map((o) => ({
      id: String(o.value ?? ""),
      name: String(o.name ?? ""),
      description: (o.description as string) ?? null,
    })),
  };
}

/**
 * 将选项拍平（configOptions 可能是分组结构，如 [{ group: "...", options: [...] }]）
 */
function flattenOptions(rawOptions: unknown): Array<Record<string, unknown>> {
  const arr: Array<Record<string, unknown>> = Array.isArray(rawOptions) ? rawOptions : [];

  const flatOptions: Array<Record<string, unknown>> = [];
  for (const opt of arr) {
    if ("group" in opt && Array.isArray(opt.options)) {
      flatOptions.push(...(opt.options as Array<Record<string, unknown>>));
    } else {
      flatOptions.push(opt);
    }
  }
  return flatOptions;
}
