import type { ToolCallData, ToolCardKind } from "../../src/lib/types";

// =============================================================================
// 工具卡片样式 — 基于 ToolCardKind
// =============================================================================

export interface CardStyle {
  /** 图标容器背景 */
  iconBg: string;
  /** 图标颜色 */
  iconColor: string;
  /** 卡片背景 */
  cardBg: string;
}

/** 基于 ToolCardKind 的样式表 */
const CARD_STYLES: Record<ToolCardKind, CardStyle> = {
  "read-file": {
    iconBg: "bg-cyan-100 dark:bg-cyan-900/40",
    iconColor: "text-cyan-600 dark:text-cyan-400",
    cardBg: "bg-cyan-50/40 dark:bg-cyan-950/20",
  },
  "read-directory": {
    iconBg: "bg-cyan-100 dark:bg-cyan-900/40",
    iconColor: "text-cyan-600 dark:text-cyan-400",
    cardBg: "bg-cyan-50/40 dark:bg-cyan-950/20",
  },
  write: {
    iconBg: "bg-blue-100 dark:bg-blue-900/40",
    iconColor: "text-blue-600 dark:text-blue-400",
    cardBg: "bg-blue-50/40 dark:bg-blue-950/20",
  },
  edit: {
    iconBg: "bg-amber-100 dark:bg-amber-900/40",
    iconColor: "text-amber-600 dark:text-amber-400",
    cardBg: "bg-amber-50/40 dark:bg-amber-950/20",
  },
  bash: {
    iconBg: "bg-emerald-100 dark:bg-emerald-900/40",
    iconColor: "text-emerald-600 dark:text-emerald-400",
    cardBg: "bg-emerald-50/40 dark:bg-emerald-950/20",
  },
  grep: {
    iconBg: "bg-cyan-100 dark:bg-cyan-900/40",
    iconColor: "text-cyan-600 dark:text-cyan-400",
    cardBg: "bg-cyan-50/40 dark:bg-cyan-950/20",
  },
  glob: {
    iconBg: "bg-cyan-100 dark:bg-cyan-900/40",
    iconColor: "text-cyan-600 dark:text-cyan-400",
    cardBg: "bg-cyan-50/40 dark:bg-cyan-950/20",
  },
  "web-fetch": {
    iconBg: "bg-pink-100 dark:bg-pink-900/40",
    iconColor: "text-pink-600 dark:text-pink-400",
    cardBg: "bg-pink-50/40 dark:bg-pink-950/20",
  },
  "web-search": {
    iconBg: "bg-pink-100 dark:bg-pink-900/40",
    iconColor: "text-pink-600 dark:text-pink-400",
    cardBg: "bg-pink-50/40 dark:bg-pink-950/20",
  },
  task: {
    iconBg: "bg-violet-100 dark:bg-violet-900/40",
    iconColor: "text-violet-600 dark:text-violet-400",
    cardBg: "bg-violet-50/40 dark:bg-violet-950/20",
  },
  todo: {
    iconBg: "bg-violet-100 dark:bg-violet-900/40",
    iconColor: "text-violet-600 dark:text-violet-400",
    cardBg: "bg-violet-50/40 dark:bg-violet-950/20",
  },
  skill: {
    iconBg: "bg-teal-100 dark:bg-teal-900/40",
    iconColor: "text-teal-600 dark:text-teal-400",
    cardBg: "bg-teal-50/40 dark:bg-teal-950/20",
  },
  question: {
    iconBg: "bg-gray-100 dark:bg-gray-800/40",
    iconColor: "text-gray-500 dark:text-gray-400",
    cardBg: "bg-gray-50/40 dark:bg-gray-900/20",
  },
  unknown: {
    iconBg: "bg-gray-100 dark:bg-gray-800/40",
    iconColor: "text-gray-500 dark:text-gray-400",
    cardBg: "bg-gray-50/40 dark:bg-gray-900/20",
  },
};

/**
 * 通过 ToolCardKind 获取卡片样式。
 * 替代旧 getCardCategory()。
 */
export function cardKindToStyle(kind: ToolCardKind): CardStyle {
  return CARD_STYLES[kind] ?? CARD_STYLES.unknown;
}

// =============================================================================
// 工具名称 — kind → 可读名
// =============================================================================

/** ToolCardKind → 可读的工具名称（如 "Read"、"Bash"） */
const KIND_LABELS: Record<ToolCardKind, string> = {
  "read-file": "Read",
  "read-directory": "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  "web-fetch": "Fetch",
  "web-search": "Search",
  task: "Task",
  todo: "Todo",
  skill: "Skill",
  question: "Question",
  unknown: "",
};

/**
 * 工具名简化为可读显示名。
 * 兼容旧调用方式（传入 title 字符串）和新方式（传入 kind）。
 */
export function simplifyToolName(titleOrKind: string): string {
  // 新路径：如果是已知 kind 值则直接映射
  if (titleOrKind in KIND_LABELS) {
    return KIND_LABELS[titleOrKind as ToolCardKind];
  }
  // 旧路径：从 title 字符串解析（兜底 display 场景）
  const lower = titleOrKind.toLowerCase();
  if (lower.includes("multiedit") || lower.includes("multi_edit")) return "MultiEdit";
  if (lower.includes("edit") || lower.includes("str_replace")) return "Edit";
  if (lower.includes("write")) return "Write";
  if (lower.includes("bash") || lower.includes("shell") || lower === "command") return "Bash";
  if (lower.includes("read")) return "Read";
  if (lower.startsWith("grep")) return "Grep";
  if (lower.startsWith("glob")) return "Glob";
  if (lower.includes("webfetch") || lower.includes("web_fetch")) return "Fetch";
  if (lower.includes("websearch") || lower.includes("web_search")) return "Search";
  if (lower.includes("todowrite") || lower.includes("todo_write")) return "Todo";
  if (lower.startsWith("task")) return "Task";
  const match = titleOrKind.match(/^([A-Za-z]+)/);
  if (match) return match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
  return titleOrKind;
}

/** 通过 kind 获取可读工具名 */
export function kindLabel(kind: ToolCardKind): string {
  return KIND_LABELS[kind] || "";
}

// =============================================================================
// 工具函数
// =============================================================================

/** 截断字符串，超长加省略号 */
export function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

/** 判断是否为 hindsight 工具（HindsightToolCard 用此函数过滤） */
export function isHindsightTool(title: string): boolean {
  return title.toLowerCase().startsWith("hindsight_");
}

/**
 * 把工具调用的输出（content 数组或 rawOutput）格式化为单行字符串，
 * 供 ToolCallDialog 的"输出"区域渲染。
 */
export function formatOutput(tool: ToolCallData): string {
  if (tool.content && tool.content.length > 0) {
    const texts = tool.content
      .filter((c): c is Extract<typeof c, { type: "content" }> => c.type === "content")
      .filter((c) => c.content.type === "text" && "text" in c.content)
      .map((c) => (c.content as { text: string }).text);
    if (texts.length > 0) return truncate(texts.join("\n"), 2000);
  }
  if (tool.rawOutput && Object.keys(tool.rawOutput).length > 0) {
    return truncate(JSON.stringify(tool.rawOutput, null, 2), 2000);
  }
  return "";
}

// =============================================================================
// 导出
// =============================================================================

export { CARD_STYLES };
