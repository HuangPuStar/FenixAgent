/**
 * 调用图的语义判据（移植自 langfuse-lite 的 `shared/components/observation-trace-graph-semantics.ts`）。
 *
 * 移植差异只有类型来源：`Observation` 换成本包视图模型 {@link TraceObservation}（视图模型的定义权在
 * `../observation-types`，图不另立一套）。
 *
 * 为什么这些规则要独立成文件：执行模式（同步 / 后台）在上游协议里**没有专列字段**，只能从命名约定与
 * `input` / `metadata` 的显式标记推断。判据集中一处，布局、行渲染与详情面板才可能得出同一结论；散在各处
 * 会退化成「图说后台、详情说同步」这种自相矛盾。
 */
import type { TraceObservation } from "../observation-types";

/** 与时间线的 AGENT + subagent* 约定一致，同时接受 bg/background/async 前缀。 */
export function isGraphSubagent(observation: TraceObservation): boolean {
  return observation.type === "AGENT" && /^(?:(?:bg|background|async)[\s:._-]+)?subagent/i.test(observation.name ?? "");
}

function hasBackgroundFlag(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (typeof value === "string") {
    // 部分 SDK 会把 input/metadata 序列化成字符串。只解析 JSON 容器，绝不把 prompt 散文当 JSON 试解析。
    if (!value.trimStart().startsWith("{")) return false;
    try {
      return hasBackgroundFlag(JSON.parse(value), depth + 1);
    } catch {
      // 损坏的遥测数据是不可信的展示数据，不足以断定执行模式。
      return false;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const [key, flag] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[_\-.]/g, "");
    if (
      ["runinbackground", "background", "isbackground", "async", "isasync", "detached"].includes(normalized) &&
      (flag === true || flag === 1 || flag === "true" || flag === "1")
    ) {
      return true;
    }
    if (
      ["mode", "executionmode"].includes(normalized) &&
      typeof flag === "string" &&
      /^(background|async|detached)$/i.test(flag)
    ) {
      return true;
    }
    if (
      ["input", "metadata", "args", "arguments", "parameters", "options"].includes(normalized) &&
      hasBackgroundFlag(flag, depth + 1)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 执行模式没有专用 API 字段：显式 input/metadata 标记与 bg/background/async 命名 token 是既定约定，
 * **不能**用时间重叠来推断（并发 ≠ 后台）。
 *
 * 启动器 TOOL 可以携带该标记，因此向上追溯时遇到最近的 TOOL/AGENT 即停：否则嵌套的同步子 agent 会
 * 意外继承外层的后台设置。
 */
export function isBackgroundSubagent(
  observation: TraceObservation,
  byId: ReadonlyMap<string, TraceObservation>,
): boolean {
  if (
    /\b(bg|background|async)\b/i.test((observation.name ?? "").replace(/_/g, " ")) ||
    hasBackgroundFlag(observation.metadata) ||
    hasBackgroundFlag(observation.input)
  ) {
    return true;
  }
  const seen = new Set([observation.id]);
  let parentId = observation.parentObservationId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent || parent.type === "AGENT") break;
    if (parent.type === "TOOL") {
      return hasBackgroundFlag(parent.metadata) || hasBackgroundFlag(parent.input);
    }
    parentId = parent.parentObservationId;
  }
  return false;
}
