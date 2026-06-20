/**
 * 从 ACP session 的 configOptions 中提取模型选择状态。
 *
 * SDK 0.28.1 起 NewSessionResponse/LoadSessionResponse/ResumeSessionResponse 的
 * `models` 字段已移除，改用统一的 configOptions 机制承载模型列表和当前选择。
 * 本函数负责将 configOptions 格式转换为内部使用的 SessionModelState 格式。
 */
import type { SessionModelState } from "./types.js";

export function extractModelState(
  configOptions: Array<Record<string, unknown>> | null | undefined,
): SessionModelState | null {
  if (!configOptions) return null;

  // 通过 id 或 category 定位模型选项（不同 agent 实现可能只用其一）
  const modelOption = configOptions.find((o) => o.type === "select" && (o.id === "model" || o.category === "model"));
  if (!modelOption) return null;

  // 部分 agent 返回 currentValue，部分使用 value
  const rawOptions: Array<Record<string, unknown>> = Array.isArray(modelOption.options) ? modelOption.options : [];

  // 将选项拍平（configOptions 可能是分组结构）
  const flatOptions: Array<Record<string, unknown>> = [];
  for (const opt of rawOptions) {
    if ("group" in opt && Array.isArray(opt.options)) {
      flatOptions.push(...(opt.options as Array<Record<string, unknown>>));
    } else {
      flatOptions.push(opt);
    }
  }

  return {
    currentModelId: String(modelOption.currentValue ?? modelOption.value ?? ""),
    availableModels: flatOptions.map((o) => ({
      modelId: String(o.value ?? ""),
      name: String(o.name ?? ""),
      description: (o.description as string) ?? null,
    })),
  };
}
