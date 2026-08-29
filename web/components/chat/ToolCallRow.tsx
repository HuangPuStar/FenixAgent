import { CircleX, CodeXml, ExternalLink, Loader2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "../../src/i18n";
import type { ToolCallData, ToolCardKind } from "../../src/lib/types";
import { cn } from "../../src/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { narrate } from "./narrators";
import { SubAgentPanel } from "./SubAgentPanel";
import { TodoChanges } from "./TodoChanges";
import { cardKindToStyle, formatOutput, kindLabel, supportsFilePreview, truncate } from "./tool-call-utils";

/**
 * 从工具调用的 rawInput 中提取文件路径。
 * 兼容 Edit/Write 工具的不同参数命名（file_path / path / filePath）。
 * 返回 null 表示该工具调用未操作文件。
 */
function extractPreviewPath(rawInput: Record<string, unknown> | undefined): string | null {
  if (!rawInput) return null;
  const path = rawInput.file_path ?? rawInput.path ?? rawInput.filePath;
  return typeof path === "string" && path.length > 0 ? path : null;
}

// =============================================================================
// 单张工具卡片 — 调用 narrate() 生成统一格式的人话文案
// =============================================================================

interface ToolCallRowProps {
  tool: ToolCallData;
}

export function ToolCallRow({ tool }: ToolCallRowProps) {
  const { t: tComponents } = useTranslation("components");
  const { t: tNarrator } = useTranslation(NS.TOOL_NARRATOR);
  const [dialogOpen, setDialogOpen] = useState(false);

  // 工具调用耗时计算：mount 时记录 startedAt，进入终态时冻结 elapsedMs。
  // 用 ref 而非 state，避免无谓重渲染；mount 即记录，覆盖实时聊天场景。
  // 历史回放（页面刷新）场景下 startedAt 不准，narrate 会显示 0ms 徽章或不显示，
  // 这是 spec 风险章节认可的权衡。
  const startedAtRef = useRef<number>(Date.now());
  const frozenElapsedRef = useRef<number | null>(null);
  const isTerminalStatus = tool.status === "complete" || tool.status === "error" || tool.status === "canceled";
  // 终态首次出现时冻结 elapsed，后续不再变化（避免 complete 状态下 elapsed 持续增长）
  if (isTerminalStatus && frozenElapsedRef.current === null) {
    frozenElapsedRef.current = Date.now() - startedAtRef.current;
  }
  const elapsedMs = frozenElapsedRef.current ?? undefined;

  // 调用 narrate 拿到统一的展示数据
  const result = narrate(tool, tool.status, elapsedMs, tNarrator);
  const titleText = typeof result.title === "string" ? result.title : undefined;

  // 通过 kind 获取卡片样式
  const kind: ToolCardKind = tool.kind ?? "unknown";
  const style = cardKindToStyle(kind);
  const Icon = result.icon ?? Loader2;

  const isRunning = tool.status === "running";
  const isError = tool.status === "error";
  const isPending = tool.status === "waiting_for_confirmation";
  const isCanceled = tool.status === "canceled" || tool.status === "rejected";
  const RowIcon = isError ? CircleX : Icon;
  const hasSubEntries = (tool.subEntries?.length ?? 0) > 0;

  const hasParams = Boolean(
    (tool.rawInput && Object.keys(tool.rawInput).length > 0) ||
      (!isRunning && !isPending && (tool.rawOutput || tool.content)),
  );
  const hasDetails = hasParams && !isPending;

  // 优先使用 display.path（引擎提供的真实文件路径），兜底走 rawInput。
  const previewPath = tool.display?.path ?? extractPreviewPath(tool.rawInput);
  // 仅允许文件读写工具打开文件，其他携带 path 的工具（如 Glob、Grep）不应触发文件预览。
  const canPreviewFile = previewPath && supportsFilePreview(kind);

  const openDialog = useCallback(() => {
    if (hasDetails) setDialogOpen(true);
  }, [hasDetails]);

  // 点击预览按钮：发送事件通知 ArtifactsPanel 展开并打开文件预览
  const handlePreviewFile = useCallback(() => {
    if (!previewPath) return;
    window.dispatchEvent(new CustomEvent("artifacts:preview-file", { detail: { path: previewPath } }));
  }, [previewPath]);

  return (
    <div>
      <div className={cn("tool-call-row-compact", isError && "is-error", isCanceled && "is-cancelled")}>
        {/* 整行只在确有详情时可交互；disabled 由 native button 语义统一暴露。 */}
        <button
          type="button"
          className="chat-tool-call-row"
          data-kind={kind}
          disabled={!hasDetails}
          onClick={openDialog}
        >
          <span className="tool-call-row-icon" aria-hidden>
            {isRunning ? <Loader2 className="animate-spin" /> : <RowIcon />}
          </span>

          <span className="tool-call-row-copy">
            <span className="tool-call-row-heading">
              <strong title={titleText}>{result.title}</strong>
              {result.errorDetail && (
                <span className="tool-call-row-error" title={result.errorDetail}>
                  {result.errorDetail}
                </span>
              )}
            </span>
            <span className="tool-call-row-meta">
              <span className="truncate">{result.subtitle}</span>
              {result.badge && (
                <span
                  className={cn(
                    "text-[10px] shrink-0",
                    result.badge.tone === "success" && "text-emerald-600 dark:text-emerald-400",
                    result.badge.tone === "error" && "text-status-error",
                    result.badge.tone === "warn" && "text-amber-600 dark:text-amber-400",
                    result.badge.tone === "info" && "text-text-dim",
                  )}
                >
                  {result.badge.text}
                </span>
              )}
            </span>
          </span>

          <span
            className={cn(
              "tool-call-row-status text-[10px] font-medium shrink-0",
              isError && "text-status-error",
              isPending && "text-brand",
              isCanceled && "text-text-dim",
              !isError && !isPending && !isCanceled && "text-text-dim",
            )}
          >
            {result.statusLabel}
          </span>

          {hasDetails && <CodeXml className="chat-tool-call-row-details-icon" aria-hidden />}
        </button>

        {tool.publicError && (
          <div className="tool-call-row-public-error text-[10px] text-status-error/80" role="alert">
            <p>{tool.publicError.message}</p>
            <p className="break-all">Type: {tool.publicError.type}</p>
            <p className="break-all">ID: {tool.publicError.id}</p>
          </div>
        )}

        {/* 文件预览是独立操作，不嵌套在整行 button 中。 */}
        {canPreviewFile && !isPending && (
          <button
            type="button"
            onClick={handlePreviewFile}
            className="h-6 px-2 gap-1 rounded-md flex items-center shrink-0 text-xs text-blue-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
            title={tComponents("toolCallRow.previewFile", { path: previewPath })}
          >
            <ExternalLink className="h-3 w-3" />
            <span>{tComponents("toolCallRow.openFile", "打开文件")}</span>
          </button>
        )}
      </div>

      {/* TodoWrite 仅展示相较上一轮的变更，完整清单由输入框上方的 TodoPanel 承载。 */}
      {tool.todoChanges && <TodoChanges changes={tool.todoChanges} />}

      {/* 子 agent 嵌套面板（保留） */}
      {hasSubEntries && (
        <div className="max-h-64 overflow-y-auto mx-1 mt-1 mb-1 rounded-md border border-border/40 bg-surface-0/50">
          <div className="px-2 py-2">
            <SubAgentPanel entries={tool.subEntries!} />
          </div>
        </div>
      )}

      {/* 参数弹窗（保留） */}
      {hasParams && (
        <ToolCallDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          tool={tool}
          kind={kind}
          style={style}
          icon={Icon}
          title={result.title}
          t={tComponents}
        />
      )}
    </div>
  );
}

// =============================================================================
// 参数弹窗 — 展示入参出参原始 JSON
// =============================================================================

interface ToolCallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tool: ToolCallData;
  kind: ToolCardKind;
  style: { iconBg: string; iconColor: string };
  icon: React.ComponentType<{ className?: string }>;
  title: React.ReactNode;
  t: (key: string) => string;
}

function ToolCallDialog({ open, onOpenChange, tool, kind, style, icon: Icon, title, t }: ToolCallDialogProps) {
  const isError = tool.status === "error";
  const isRunning = tool.status === "running";
  const hasOutput = !isRunning && (tool.rawOutput || tool.content);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-fit p-0 gap-0">
        <DialogHeader className="px-4 py-3 border-b border-border">
          <DialogTitle className="text-sm font-medium flex items-center gap-2.5">
            <div className={cn("h-7 w-7 rounded-lg flex items-center justify-center shrink-0", style.iconBg)}>
              <Icon className={cn("h-3.5 w-3.5", style.iconColor)} />
            </div>
            {/* 主标题为人性化句子；下方附原始工具名，便于用户识别工具类型 */}
            <div className="flex flex-col min-w-0 gap-0.5">
              <span className="truncate">{title}</span>
              <span className="text-[10px] text-text-dim font-mono truncate leading-tight">
                {kindLabel(kind) ? `${t("toolCallRow.toolName")}: ${kindLabel(kind)}` : t("toolCallRow.toolName")}
              </span>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="px-4 py-3 space-y-3 max-h-[60vh] overflow-y-auto">
          {tool.rawInput && Object.keys(tool.rawInput).length > 0 && (
            <div>
              <div className="text-[9px] font-semibold uppercase tracking-widest text-text-dim mb-1.5">
                {t("toolCallGroup.input")}
              </div>
              <pre className="tool-call-detail-code text-[11px] bg-surface-2 rounded-md px-3 py-2.5 overflow-auto font-mono text-text-secondary leading-relaxed">
                {truncate(JSON.stringify(tool.rawInput, null, 2), 3000)}
              </pre>
            </div>
          )}
          {hasOutput && (
            <div>
              <div className="text-[9px] font-semibold uppercase tracking-widest text-text-dim mb-1.5">
                {t("toolCallGroup.output")}
              </div>
              <pre
                className={cn(
                  "tool-call-detail-code text-[11px] rounded-md px-3 py-2.5 overflow-auto font-mono leading-relaxed",
                  isError ? "bg-status-error/6 text-status-error" : "bg-surface-2 text-text-secondary",
                )}
              >
                {formatOutput(tool)}
              </pre>
            </div>
          )}
          {isRunning && !hasOutput && <p className="text-xs text-text-dim italic">{t("toolCallRow.running")}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
