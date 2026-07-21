/**
 * 从 ACP session 的 configOptions 中提取模型选择状态。
 *
 * SDK 0.28.1 起 NewSessionResponse/LoadSessionResponse/ResumeSessionResponse 的
 * `models` 字段已移除，改用统一的 configOptions 机制承载模型列表和当前选择。
 * 本函数负责将 configOptions 格式转换为内部使用的 SessionModelState 格式。
 *
 * **currentModelId 校验**：若 agent 返回的 currentModelId 不在 availableModels 中
 * （如 agent 内部使用了一个未公开的模型标识），自动回退到第一个可用模型。
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

  const availableModels = flatOptions.map((o) => ({
    modelId: String(o.value ?? ""),
    name: String(o.name ?? ""),
    description: (o.description as string) ?? null,
    modalities: (o.modalities as ModelModalities) ?? null,
  }));

  const rawCurrent = String(modelOption.currentValue ?? modelOption.value ?? "");
  const currentModelId = sanitizeCurrentId(
    rawCurrent,
    availableModels.map((m) => m.modelId),
    "model",
  );

  return { currentModelId, availableModels };
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

  const availableModes = flatOptions.map((o) => ({
    id: String(o.value ?? ""),
    name: String(o.name ?? ""),
    description: (o.description as string) ?? null,
  }));

  const rawCurrent = String(modeOption.currentValue ?? modeOption.value ?? "");
  const currentModeId = sanitizeCurrentId(
    rawCurrent,
    availableModes.map((m) => m.id),
    "mode",
  );

  return { currentModeId, availableModes };
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

/**
 * 校验并修正 currentId：若不在合法 id 列表中，回退到第一个有效 id。
 *
 * 部分 agent 可能在 configOptions 的 currentValue 或 models.currentModelId 中返回
 * 一个不在 availableModels 里的值（例如 agent 内部绑定的模型标识未暴露到选项列表），
 * 此时自动回退到第一个可用项，避免前端显示异常。
 */
function sanitizeCurrentId(rawId: string, validIds: string[], kind: "model" | "mode"): string {
  if (!rawId) return rawId;

  if (validIds.length === 0) {
    // 无可用选项时保留原始值（无法修正）
    if (rawId) {
      console.warn(`[config-options] no available ${kind}s to validate current ${kind}Id: "${rawId}"`);
    }
    return rawId;
  }

  if (validIds.includes(rawId)) return rawId;

  const fallback = validIds[0];
  console.warn(
    `[config-options] current ${kind}Id "${rawId}" not found in available ${kind}s, ` + `falling back to "${fallback}"`,
  );
  return fallback;
}
