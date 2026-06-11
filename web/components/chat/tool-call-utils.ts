import {
  BookOpen,
  Bot,
  CodeXml,
  Eye,
  FileCode,
  FilePen,
  Files,
  FileText,
  Globe,
  ListChecks,
  Search,
  Terminal,
  Zap,
} from "lucide-react";
import { type ComponentType } from "react";
import type { ToolCallData } from "../../src/lib/types";

// =============================================================================
// 工具类别 & 卡片样式配置
// =============================================================================

type ToolCategory = "shell" | "file-write" | "file-edit" | "file-read" | "web" | "ai" | "skill" | "default";

interface CardStyle {
  /** 图标容器背景 */
  iconBg: string;
  /** 图标颜色 */
  iconColor: string;
  /** 卡片背景 */
  cardBg: string;
}

const CARD_STYLES: Record<ToolCategory, CardStyle> = {
  shell: {
    iconBg: "bg-emerald-100 dark:bg-emerald-900/40",
    iconColor: "text-emerald-600 dark:text-emerald-400",
    cardBg: "bg-emerald-50/40 dark:bg-emerald-950/20",
  },
  "file-write": {
    iconBg: "bg-blue-100 dark:bg-blue-900/40",
    iconColor: "text-blue-600 dark:text-blue-400",
    cardBg: "bg-blue-50/40 dark:bg-blue-950/20",
  },
  "file-edit": {
    iconBg: "bg-amber-100 dark:bg-amber-900/40",
    iconColor: "text-amber-600 dark:text-amber-400",
    cardBg: "bg-amber-50/40 dark:bg-amber-950/20",
  },
  "file-read": {
    iconBg: "bg-cyan-100 dark:bg-cyan-900/40",
    iconColor: "text-cyan-600 dark:text-cyan-400",
    cardBg: "bg-cyan-50/40 dark:bg-cyan-950/20",
  },
  web: {
    iconBg: "bg-pink-100 dark:bg-pink-900/40",
    iconColor: "text-pink-600 dark:text-pink-400",
    cardBg: "bg-pink-50/40 dark:bg-pink-950/20",
  },
  ai: {
    iconBg: "bg-violet-100 dark:bg-violet-900/40",
    iconColor: "text-violet-600 dark:text-violet-400",
    cardBg: "bg-violet-50/40 dark:bg-violet-950/20",
  },
  skill: {
    iconBg: "bg-teal-100 dark:bg-teal-900/40",
    iconColor: "text-teal-600 dark:text-teal-400",
    cardBg: "bg-teal-50/40 dark:bg-teal-950/20",
  },
  default: {
    iconBg: "bg-gray-100 dark:bg-gray-800/40",
    iconColor: "text-gray-500 dark:text-gray-400",
    cardBg: "bg-gray-50/40 dark:bg-gray-900/20",
  },
};

const STATUS_BAR: Record<string, string> = {
  running: "bg-status-running",
  complete: "bg-status-active/30",
  error: "bg-status-error",
  waiting_for_confirmation: "bg-brand",
  canceled: "bg-surface-3",
  rejected: "bg-status-error/40",
};

// =============================================================================
// 工具类型分类 — 比 category 更细粒度，区分 write 和 edit
// =============================================================================

function getCardCategory(title: string, rawInput?: Record<string, unknown>): ToolCategory {
  const lower = title.toLowerCase();
  if (lower.includes("bash") || lower.includes("shell") || lower === "command") return "shell";
  if (lower.includes("write")) return "file-write";
  if (lower.includes("edit") || lower.includes("str_replace") || lower.includes("multiedit")) return "file-edit";
  if (lower.includes("read")) return "file-read";
  if (lower.includes("grep") || lower.includes("glob") || lower.includes("list") || lower.includes("find"))
    return "file-read";
  if (lower.includes("webfetch") || lower.includes("web_fetch")) return "web";
  if (lower.includes("websearch") || lower.includes("web_search")) return "web";
  if (lower.includes("search")) return "file-read";
  if (lower.includes("task") || lower.includes("agent") || lower.includes("todowrite") || lower.includes("todo_write"))
    return "ai";
  if (lower.startsWith("loaded skill")) return "skill";
  // 兜底：通过 rawInput 字段结构推断工具类型
  // filePath → read；pattern + include → grep；pattern（无 include）→ glob；command → shell；file_path/path + newText → edit/write
  if (rawInput) {
    if (typeof rawInput.filePath === "string" || typeof rawInput.path === "string") {
      if (typeof rawInput.newText === "string" || typeof rawInput.content === "string") return "file-write";
      if (typeof rawInput.oldText === "string" || typeof rawInput.old_string === "string") return "file-edit";
      return "file-read";
    }
    if (typeof rawInput.pattern === "string") {
      return typeof rawInput.include === "string" ? "file-read" : "file-read";
    }
    if (typeof rawInput.command === "string" || typeof rawInput.cmd === "string") return "shell";
    if (typeof rawInput.url === "string") return "web";
    if (typeof rawInput.query === "string") return "file-read";
  }
  return "default";
}

/** 按工具名选择图标（最细粒度） */
function getToolIcon(title: string, rawInput?: Record<string, unknown>): ComponentType<{ className?: string }> {
  const lower = title.toLowerCase();
  if (lower.includes("bash") || lower.includes("shell") || lower === "command") return Terminal;
  if (lower.includes("write")) return FileText;
  if (lower.includes("edit") || lower.includes("str_replace") || lower.includes("multiedit")) return FilePen;
  if (lower.includes("read")) return Eye;
  if (lower.includes("grep") || lower.includes("search")) return Search;
  if (lower.includes("glob") || lower.includes("list")) return Files;
  if (lower.includes("webfetch") || lower.includes("websearch") || lower.includes("web_")) return Globe;
  if (lower.includes("todowrite") || lower.includes("todo_write")) return ListChecks;
  if (lower.startsWith("task") || lower.startsWith("agent")) return Bot;
  if (lower.startsWith("loaded skill")) return BookOpen;
  // 兜底：与 getCardCategory 一致的 rawInput 推断
  if (rawInput) {
    if (typeof rawInput.filePath === "string" || typeof rawInput.path === "string") {
      if (typeof rawInput.newText === "string" || typeof rawInput.content === "string") return FileText;
      if (typeof rawInput.oldText === "string" || typeof rawInput.old_string === "string") return FilePen;
      return Eye;
    }
    if (typeof rawInput.pattern === "string") return Search;
    if (typeof rawInput.command === "string" || typeof rawInput.cmd === "string") return Terminal;
    if (typeof rawInput.url === "string") return Globe;
  }
  return Zap;
}

// =============================================================================
// 工具函数
// =============================================================================

function simplifyToolName(title: string): string {
  const lower = title.toLowerCase();
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
  const match = title.match(/^([A-Za-z]+)/);
  if (match) return match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
  return title;
}

function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

function extractFilePath(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const directPath = input.file_path ?? input.path;
  if (typeof directPath === "string" && directPath) return directPath;
  const edits = input.edits;
  if (Array.isArray(edits) && edits.length > 0) {
    const first = (edits[0] as Record<string, unknown>)?.file_path;
    if (typeof first === "string") {
      return edits.length > 1 ? `${first} 等 ${edits.length} 个文件` : first;
    }
  }
  return null;
}

/** 把路径格式化为文件名（multiedit 特殊处理："utils.ts 等 3 个文件"） */
function formatFileName(path: string, lower: string): string {
  if (lower.includes("multiedit") || lower.includes("multi_edit")) {
    // extractFilePath 返回 "fullPath 等 N 个文件"，需要从第一段提取文件名
    const firstPath = path.split(" 等 ")[0];
    return firstPath.split("/").pop() ?? firstPath;
  }
  return path.split("/").pop() ?? path;
}

/** 从 rawInput 提取第一个文件路径（用于 title 属性 tooltip） */
function extractFirstPath(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const direct = input.file_path ?? input.path;
  if (typeof direct === "string") return direct;
  const edits = input.edits;
  if (Array.isArray(edits) && edits.length > 0) {
    const first = (edits[0] as Record<string, unknown>)?.file_path;
    if (typeof first === "string") return first;
  }
  return "";
}

function countDiffs(content: ToolCallData["content"]): number {
  if (!content) return 0;
  return content.filter((c) => c.type === "diff").length;
}

function formatOutput(tool: ToolCallData): string {
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

/** 从 rawInput 结构推断工具类型（当 title 无法匹配时兜底使用） */
function inferToolTypeFromInput(
  input: Record<string, unknown> | undefined,
  lower: string,
): "search" | "read" | "write" | "edit" | "skill" | null {
  if (!input) return null;
  // 有 pattern → search（grep/glob 无论有无 include 都是搜索）
  if (typeof input.pattern === "string") return "search";
  // 有 filePath（无 newText）→ read
  if (typeof input.filePath === "string" && typeof input.newText !== "string" && typeof input.oldText !== "string")
    return "read";
  return null;
}

/** 判断是否为 hindsight 工具 */
function isHindsightTool(title: string): boolean {
  return title.toLowerCase().startsWith("hindsight_");
}

// =============================================================================
// 导出
// =============================================================================

export {
  CARD_STYLES,
  type CardStyle,
  countDiffs,
  extractFilePath,
  extractFirstPath,
  formatFileName,
  formatOutput,
  getCardCategory,
  getToolIcon,
  inferToolTypeFromInput,
  isHindsightTool,
  STATUS_BAR,
  simplifyToolName,
  type ToolCategory,
  truncate,
};
