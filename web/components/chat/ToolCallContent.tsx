import type { ToolCallData } from "../../src/lib/types";
import {
  countDiffs,
  extractFilePath,
  extractFirstPath,
  formatFileName,
  inferToolTypeFromInput,
  simplifyToolName,
  truncate,
} from "./tool-call-utils";

// =============================================================================
// 工具卡片内容 — 每种工具有专属的标题 + 副标题组合
// =============================================================================

export function ToolCardContent({ tool }: { tool: ToolCallData }) {
  const input = tool.rawInput;
  const lower = tool.title.toLowerCase();
  const hasSubEntries = (tool.subEntries?.length ?? 0) > 0;
  const subToolCount = tool.subEntries?.filter((e) => e.type === "tool_call").length ?? 0;
  const subMsgCount = tool.subEntries?.filter((e) => e.type === "assistant_message").length ?? 0;

  // 流式输出时提取实时内容预览，显示在副标题
  const streamingPreview =
    tool.status === "running" && tool.content && tool.content.length > 0 ? getStreamingPreview(tool.content) : null;

  // Agent 提供的 description 优先展示
  if (tool.description) {
    return (
      <>
        <div className="text-[13px] font-medium text-text-primary truncate" title={tool.description}>
          {truncate(tool.description, 100)}
        </div>
        <div className="text-[11px] text-text-dim mt-0.5 truncate">
          {truncate(simplifyToolName(tool.title), 30)}
          {hasSubEntries && <SubCountBadge toolCount={subToolCount} msgCount={subMsgCount} />}
          {streamingPreview && <StreamingPreview text={streamingPreview} />}
        </div>
      </>
    );
  }

  // ---- Write：文档图标 + 文件名（Claude 风格大卡片） ----
  if (lower.includes("write")) {
    const path = input?.file_path ?? input?.path;
    const fileName = typeof path === "string" ? (path.split("/").pop() ?? path) : "Unknown file";
    return (
      <>
        <div
          className="text-[13px] font-medium text-text-primary truncate"
          title={typeof path === "string" ? path : undefined}
        >
          {fileName}
        </div>
        <div className="text-[11px] text-text-dim mt-0.5">
          Write
          {streamingPreview && <StreamingPreview text={streamingPreview} />}
        </div>
      </>
    );
  }

  // ---- Bash：终端风格 $ command ----
  if (lower.includes("bash") || lower.includes("shell") || lower === "command") {
    const cmd = input?.command;
    return (
      <>
        <div className="text-[13px] font-mono text-text-primary truncate">
          <span className="text-text-dim mr-1">$</span>
          {typeof cmd === "string" ? truncate(cmd, 120) : "Bash"}
        </div>
        <div className="text-[11px] text-text-dim mt-0.5">
          Bash
          {streamingPreview && <StreamingPreview text={streamingPreview} />}
        </div>
      </>
    );
  }

  // ---- Edit / StrReplace / MultiEdit：文件名 + 变更统计 ----
  if (lower.includes("edit") || lower.includes("str_replace") || lower.includes("multiedit")) {
    const path = extractFilePath(input);
    const diffCount = countDiffs(tool.content);
    // multiedit 显示 "utils.ts 等 3 个文件"，否则仅文件名
    const fileName = path ? formatFileName(path, lower) : "Unknown file";
    return (
      <>
        <div className="text-[13px] font-medium text-text-primary truncate" title={extractFirstPath(input)}>
          {fileName}
        </div>
        <div className="text-[11px] text-text-dim mt-0.5 flex items-center gap-1.5">
          <span>Edit</span>
          {diffCount > 0 && <span className="text-amber-600 dark:text-amber-400">{diffCount} 处变更</span>}
          {hasSubEntries && <SubCountBadge toolCount={subToolCount} msgCount={subMsgCount} />}
          {streamingPreview && <StreamingPreview text={streamingPreview} />}
        </div>
      </>
    );
  }

  // ---- Read：文件名 ----
  if (lower.startsWith("read")) {
    const path = input?.file_path ?? input?.path;
    const fileName = typeof path === "string" ? (path.split("/").pop() ?? path) : "Unknown file";
    return (
      <>
        <div
          className="text-[13px] font-medium text-text-primary truncate"
          title={typeof path === "string" ? path : undefined}
        >
          {fileName}
        </div>
        <div className="text-[11px] text-text-dim mt-0.5">
          Read
          {streamingPreview && <StreamingPreview text={streamingPreview} />}
        </div>
      </>
    );
  }

  // ---- Grep：搜索 pattern + 路径 ----
  if (lower.startsWith("grep") || lower.includes("search")) {
    const pattern = input?.pattern;
    const path = input?.path;
    const resultCount = getSearchResultCount(tool);
    const shortPath = typeof path === "string" ? shortenPath(path) : null;
    return (
      <>
        <div
          className="text-[13px] font-mono text-text-primary truncate"
          title={typeof pattern === "string" ? pattern : undefined}
        >
          {typeof pattern === "string" ? `"${truncate(pattern, 60)}"` : "Grep"}
        </div>
        <div className="text-[11px] text-text-dim mt-0.5 truncate">
          <span>Grep</span>
          {resultCount !== null && <span className="ml-1.5">{resultCount} 结果</span>}
          {shortPath && (
            <span className="ml-1.5 opacity-60" title={String(path)}>
              {shortPath}
            </span>
          )}
        </div>
      </>
    );
  }

  // ---- Glob：匹配 pattern ----
  if (lower.startsWith("glob") || lower.includes("find")) {
    const pattern = input?.pattern;
    const path = input?.path;
    const resultCount = getSearchResultCount(tool);
    const shortPath = typeof path === "string" ? shortenPath(path) : null;
    return (
      <>
        <div
          className="text-[13px] font-mono text-text-primary truncate"
          title={typeof pattern === "string" ? pattern : undefined}
        >
          {typeof pattern === "string" ? truncate(pattern, 80) : "Glob"}
        </div>
        <div className="text-[11px] text-text-dim mt-0.5 truncate">
          <span>Glob</span>
          {resultCount !== null && <span className="ml-1.5">{resultCount} 个文件</span>}
          {shortPath && (
            <span className="ml-1.5 opacity-60" title={String(path)}>
              {shortPath}
            </span>
          )}
        </div>
      </>
    );
  }

  // ---- WebFetch：URL ----
  if (lower.includes("webfetch") || lower.includes("web_fetch")) {
    const url = input?.url;
    return (
      <>
        <div className="text-[13px] font-mono text-text-primary truncate">
          {typeof url === "string" ? truncate(url, 80) : "Fetch"}
        </div>
        <div className="text-[11px] text-text-dim mt-0.5">Fetch</div>
      </>
    );
  }

  // ---- WebSearch：搜索词 ----
  if (lower.includes("websearch") || lower.includes("web_search")) {
    const query = input?.query;
    return (
      <>
        <div className="text-[13px] font-mono text-text-primary truncate">
          {typeof query === "string" ? `"${truncate(query, 80)}"` : "Search"}
        </div>
        <div className="text-[11px] text-text-dim mt-0.5">Search</div>
      </>
    );
  }

  // ---- Task / Agent：子任务摘要 ----
  if (lower.startsWith("task") || lower.startsWith("agent")) {
    return (
      <>
        <div className="text-[13px] text-text-primary truncate">
          {lower.startsWith("task") ? "子任务执行中" : "Agent 调用"}
        </div>
        <div className="text-[11px] text-text-dim mt-0.5">
          Task{hasSubEntries && <SubCountBadge toolCount={subToolCount} msgCount={subMsgCount} />}
        </div>
      </>
    );
  }

  // ---- TodoWrite：待办项 ----
  if (lower.includes("todowrite") || lower.includes("todo_write")) {
    const todos = input?.todos;
    const count = Array.isArray(todos) ? todos.length : 0;
    return (
      <>
        <div className="text-[13px] text-text-primary">{count > 0 ? `${count} 个待办项` : "更新待办列表"}</div>
        <div className="text-[11px] text-text-dim mt-0.5">Todo</div>
      </>
    );
  }

  // ---- Loaded skill：技能加载 ----
  if (lower.startsWith("loaded skill")) {
    const skillName = input?.name || tool.title.replace(/^loaded skill:\s*/i, "");
    // Extract first line of skill content as description
    const skillDesc = getFirstContentLine(tool.content);
    return (
      <>
        <div
          className="text-[13px] font-medium text-text-primary truncate"
          title={typeof skillName === "string" ? skillName : undefined}
        >
          {typeof skillName === "string" ? truncate(skillName, 50) : "Skill"}
        </div>
        <div className="text-[11px] text-text-dim mt-0.5">
          Skill loaded{skillDesc && ` · ${truncate(skillDesc, 40)}`}
        </div>
      </>
    );
  }

  // ---- 兜底：通过 rawInput 结构推断工具类型 ----
  const inferredType = inferToolTypeFromInput(input, lower);
  if (inferredType === "search") {
    const pattern = input?.pattern;
    const path = input?.path;
    const include = input?.include;
    // grep: 有 include 过滤；glob: 纯 pattern 匹配
    const isGrep = typeof include === "string";
    const label = isGrep ? "Grep" : "Glob";
    const resultCount = getSearchResultCount(tool);
    const shortPath = typeof path === "string" ? shortenPath(path) : null;
    return (
      <>
        <div
          className="text-[13px] font-mono text-text-primary truncate"
          title={typeof pattern === "string" ? pattern : undefined}
        >
          {typeof pattern === "string" ? `"${truncate(pattern, 60)}"` : "Search"}
        </div>
        <div className="text-[11px] text-text-dim mt-0.5 truncate">
          <span>{label}</span>
          {typeof include === "string" && <span className="ml-1 opacity-70">{include}</span>}
          {resultCount !== null && <span className="ml-1.5">{resultCount} 结果</span>}
          {shortPath && (
            <span className="ml-1.5 opacity-60" title={typeof path === "string" ? path : undefined}>
              {shortPath}
            </span>
          )}
        </div>
      </>
    );
  }
  if (inferredType === "read") {
    const path = input?.file_path ?? input?.filePath ?? input?.path;
    const fileName = typeof path === "string" ? (path.split("/").pop() ?? path) : "Unknown file";
    return (
      <>
        <div
          className="text-[13px] font-medium text-text-primary truncate"
          title={typeof path === "string" ? path : undefined}
        >
          {fileName}
        </div>
        <div className="text-[11px] text-text-dim mt-0.5">
          Read{streamingPreview && <StreamingPreview text={streamingPreview} />}
        </div>
      </>
    );
  }

  // ---- 兜底 ----
  if (input) {
    for (const v of Object.values(input)) {
      if (typeof v === "string" && v.length > 0) {
        return (
          <>
            <div className="text-[13px] font-mono text-text-primary truncate" title={v}>
              {truncate(v, 100)}
            </div>
            <div className="text-[11px] text-text-dim mt-0.5 truncate">
              {truncate(simplifyToolName(tool.title), 30)}
            </div>
          </>
        );
      }
    }
  }

  return (
    <div className="text-[13px] text-text-muted truncate" title={tool.title}>
      {truncate(simplifyToolName(tool.title), 50)}
    </div>
  );
}

// =============================================================================
// 辅助组件 & 函数
// =============================================================================

/** 从 rawOutput.metadata 提取搜索结果数 */
function getSearchResultCount(tool: ToolCallData): number | null {
  const metadata = tool.rawOutput?.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;
  if (typeof m.matches === "number") return m.matches;
  if (typeof m.count === "number") return m.count;
  return null;
}

/** 截断路径为最后 N 段（src/routes → src/routes） */
function shortenPath(path: string, segments = 2): string {
  const clean = path.replace(/^\/+/, "");
  const parts = clean.split("/");
  return parts.length > segments ? parts.slice(-segments).join("/") : clean;
}

/** 子 agent 条目计数 */
function SubCountBadge({ toolCount, msgCount }: { toolCount: number; msgCount: number }) {
  return (
    <span className="text-text-dim">
      {" "}
      · {toolCount} 工具{msgCount > 0 ? ` · ${msgCount} 消息` : ""}
    </span>
  );
}

/** 流式输出预览：副标题中显示实时内容摘要 */
function StreamingPreview({ text }: { text: string }) {
  return <span className="ml-1.5 text-text-dim/60 italic">{truncate(text, 30)}…</span>;
}

/**
 * 从 content 中提取流式输出的首行文本预览。
 * 工具执行中 content 逐步填充（如 bash 输出、文件内容等），
 * 这里取第一行用于卡片上的实时反馈。
 */
function getStreamingPreview(content: ToolCallData["content"]): string | null {
  if (!content) return null;
  for (const c of content) {
    if (c.type === "content" && c.content.type === "text" && "text" in c.content) {
      const text = (c.content as { text: string }).text;
      const firstLine = text.split("\n")[0];
      const trimmed = firstLine.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

/** 提取 content 中第一个 text 块的首行文本 */
function getFirstContentLine(content: ToolCallData["content"]): string | null {
  if (!content) return null;
  for (const c of content) {
    if (c.type === "content" && c.content.type === "text" && "text" in c.content) {
      const text = (c.content as { text: string }).text;
      const firstLine = text.split("\n")[0];
      const trimmed = firstLine.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}
