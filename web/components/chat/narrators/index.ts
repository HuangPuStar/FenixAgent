import { bashNarrator } from "./bash";
import { editNarrator } from "./edit";
import { fallbackNarrator } from "./fallback";
import { globNarrator } from "./glob";
import { grepNarrator } from "./grep";
import { extractErrorMessage, formatElapsed } from "./helpers";
import { questionNarrator } from "./question";
import { readNarrator } from "./read";
import { skillNarrator } from "./skill";
import { taskNarrator } from "./task";
import { todoWriteNarrator } from "./todo-write";
import type { NarrationBadge, NarrationContext, NarrationResult, ToolNarrator, ToolStatus } from "./types";
import { webFetchNarrator } from "./web-fetch";
import { webSearchNarrator } from "./web-search";
import { writeNarrator } from "./write";

/**
 * 注册表。顺序敏感：先匹配专用 narrator，未命中走兜底。
 *
 * 占位：后续 task 会逐步把专用 narrator（read/edit/bash/...）插入到
 * fallbackNarrator 之前。WebSearch 必须在 WebFetch 之后注册
 * （因为两者都匹配 "web"）。
 */
const narrators: ToolNarrator[] = [
  readNarrator,
  editNarrator,
  writeNarrator,
  bashNarrator,
  grepNarrator,
  globNarrator,
  webFetchNarrator,
  webSearchNarrator,
  taskNarrator,
  todoWriteNarrator,
  skillNarrator,
  questionNarrator,
  fallbackNarrator, // 必须最后
];

/**
 * 中央 narrate 入口。ToolCallRow 调用此函数拿到完整的 NarrationResult。
 *
 * 职责：
 * 1. 把 rejected 归一化为 canceled（视觉上一致）
 * 2. 查注册表匹配 narrator（未命中走 fallback）
 * 3. 用 common.subtitle / subtitleRunning 模板拼 title 行（verb + object 完整句子）
 * 4. 用 common.status.<status> 拿状态词
 * 5. error 状态额外提取错误信息
 * 6. 终态有 elapsedMs 时拼耗时徽章（subtitle 行右侧）
 *
 * title 拼接完全集中在此函数，保证所有工具格式一致，
 * narrator 只负责提供 verb + object + 可选 detail（subtitle 补充信息）。
 */
export function narrate(
  tool: NarrationContext["tool"],
  status: ToolStatus,
  elapsedMs: number | undefined,
  t: NarrationContext["t"],
): NarrationResult {
  // 第 1 阶段：状态归一化。rejected 视觉上等同 canceled（用户拒绝授权）
  const normalizedStatus: Exclude<ToolStatus, "rejected"> = status === "rejected" ? "canceled" : status;

  // 第 2 阶段：查注册表匹配 narrator
  const ctx: NarrationContext = { tool, status: normalizedStatus, elapsedMs, t };
  const lower = tool.title.toLowerCase();
  const narrator = narrators.find((n) => n.match(lower)) ?? fallbackNarrator;

  // 第 3 阶段：调用 narrator 的 getDisplay 拿到 object 和可选 detail
  const { object, detail } = narrator.getDisplay(ctx);
  const verb = narrator.verb;

  // 第 4 阶段：拼接 title（verb + object 完整句子）。running 用进行时模板（"正在读 X"），
  // 其他状态用过去时模板（"读 X"）
  const titleKey = normalizedStatus === "running" ? "common.subtitleRunning" : "common.subtitle";
  const title = t(titleKey, { verb, object });

  // 第 5 阶段：拿状态词（全局统一）
  const statusLabel = t(`common.status.${normalizedStatus}`);

  // 第 6 阶段：error 状态从 rawOutput 提取错误信息，单独显示在 title 下方
  const errorDetail = normalizedStatus === "error" ? extractErrorMessage(tool.rawOutput) : undefined;

  // 第 7 阶段：耗时徽章。complete/error 终态且有 elapsedMs 时显示
  // narrator 自定义徽章已合并到 detail（subtitle 行），这里只处理耗时徽章
  const badge: NarrationBadge | undefined =
    (normalizedStatus === "complete" || normalizedStatus === "error") && elapsedMs
      ? { tone: "info", text: formatElapsed(elapsedMs) }
      : undefined;

  return {
    icon: narrator.icon,
    title,
    subtitle: detail,
    statusLabel,
    badge,
    errorDetail,
    detail: {
      rawInput: tool.rawInput,
      rawOutput: tool.rawOutput,
    },
  };
}

export type { NarrationContext, NarrationResult, ToolNarrator, ToolStatus } from "./types";
