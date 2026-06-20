/**
 * 从 ACP session 的 configOptions 中提取模型选择状态。
 *
 * SDK 0.28.1 起 NewSessionResponse/LoadSessionResponse/ResumeSessionResponse 的
 * `models` 字段已移除，改用统一的 configOptions 机制承载模型列表和当前选择。
 * 本函数负责将 configOptions 格式转换为内部使用的 SessionModelState 格式。
 */
import type { SessionModelState } from "./types.js";

/** configOptions 元素的精简类型（避免直接依赖 SDK schema 子模块） */
interface ConfigOption {
  type: string;
  id?: string;
  category?: string | null;
  value?: string | null;
  options?: Array<
    | { value: string; name: string; description?: string | null; _meta?: Record<string, unknown> | null }
    | {
        group: string;
        name: string;
        options?: Array<{
          value: string;
          name: string;
          description?: string | null;
          _meta?: Record<string, unknown> | null;
        }>;
      }
  >;
}

export function extractModelState(configOptions: Array<ConfigOption> | null | undefined): SessionModelState | null {
  if (!configOptions) return null;

  const modelOption = configOptions.find((o) => o.category === "model" && o.type === "select");
  if (!modelOption) return null;

  // 将选项拍平（configOptions 可能是分组结构）
  const flatOptions: Array<{ value: string; name: string; description?: string | null }> = [];
  for (const opt of modelOption.options ?? []) {
    if ("group" in opt) {
      flatOptions.push(...(opt.options ?? []));
    } else {
      flatOptions.push(opt);
    }
  }

  return {
    currentModelId: modelOption.value ?? "",
    availableModels: flatOptions.map((o) => ({
      modelId: o.value,
      name: o.name,
      description: o.description ?? null,
    })),
  };
}
