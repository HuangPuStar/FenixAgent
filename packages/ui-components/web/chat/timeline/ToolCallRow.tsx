/**
 * 单张工具卡片 — 调用 narrate() 生成统一格式的人话文案。
 *
 * 来源：`packages/agent-runtime/web/components/chat/ToolCallRow.tsx` 逐字复制。
 * 纯化改动点：
 * - `window` CustomEvent（`artifacts:preview-file`，源实现由 ArtifactsPanel 监听）改为
 *   `onPreviewFile` 回调 prop：宿主注入回调时才渲染文件链接，宿主自行决定如何打开预览；
 *   源 `envId` prop 随之移除（它只用于事件载荷与渲染门控）。
 * - `cn` / Dialog / 类型 / 工具函数改从包内相对路径导入。
 * - i18n 命名空间改为 `uiComponents`：组件文案加 `chat.components.` 前缀，
 *   narrator 文案加 `chat.toolNarrator.` 前缀。
 * - 移除 `tool.publicError` 错误块（源实现在卡片右侧渲染「message + Type + ID」）：该块是
 *   `.tool-call-row-compact` 网格的第二列，与标题下方第二行的错误信息重复（`narrate` 的
 *   `errorDetail` 优先取 `publicError.message`），故只保留第二行；脱敏错误的 Type / ID 不再展示。
 */

import { CircleX, CodeXml, Loader2 } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { UI_COMPONENTS_NS } from "../../lib/i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/dialog";
import { cardKindToStyle, formatOutput, kindLabel, supportsFilePreview, truncate } from "../lib/tool-call-utils";
import { narrate } from "../narrators";
import { Shimmer } from "../primitives/shimmer";
import type { ToolCallData, ToolCardKind } from "../types";
import { SubAgentPanel } from "./SubAgentPanel";
import { TodoChanges } from "./TodoChanges";

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

/**
 * 运行中的标题文字套一层载入微光。
 *
 * 纯化改动点（相对源实现）：源实现运行时只有 `Loader2` 转圈 + 静态标题，没有微光；
 * 这里复用包内统一的 `chat/primitives/shimmer`（reasoning 的「思考中」同源）。
 * 非运行态、或节点不是纯文本（含文件链接等交互元素）时原样返回，避免把按钮也染成微光。
 */
function withLoadingShimmer(node: ReactNode, isLoading: boolean): ReactNode {
  return isLoading && typeof node === "string" ? <Shimmer as="span">{node}</Shimmer> : node;
}

// =============================================================================
// 单张工具卡片 — 调用 narrate() 生成统一格式的人话文案
// =============================================================================

interface ToolCallRowProps {
  tool: ToolCallData;
  /** 宿主注入的文件预览回调（源实现为 `artifacts:preview-file` 事件）；缺省时不渲染文件链接。 */
  onPreviewFile?: (path: string) => void;
}

/** 工具调用卡片：图标 + 人话标题 + 状态/耗时徽章 + 参数弹窗，可选文件预览链接与子 Agent 面板。复制自 `packages/agent-runtime/web/components/chat/ToolCallRow.tsx`。 */
export function ToolCallRow({ tool, onPreviewFile }: ToolCallRowProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
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
  const result = narrate(tool, tool.status, elapsedMs, t);
  const titleText = typeof result.title === "string" ? result.title : undefined;

  // 通过 kind 获取卡片样式
  const kind: ToolCardKind = tool.kind ?? "unknown";
  const style = cardKindToStyle(kind);
  const Icon = result.icon ?? Loader2;

  const isRunning = tool.status === "running";
  // 完成是默认结果：右侧不再渲染「Done / 已完成」这类状态词（见下方状态位渲染）
  const isComplete = tool.status === "complete";
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
  // 纯化：宿主回调存在时才渲染文件链接（源实现额外要求 envId）。
  const canPreviewFile = Boolean(previewPath && supportsFilePreview(kind) && onPreviewFile);
  const showFileLink = canPreviewFile && !isPending;
  const fileAction = canPreviewFile
    ? t(isRunning ? "chat.toolNarrator.common.subtitleRunning" : "chat.toolNarrator.common.subtitle", {
        verb: result.verb,
        object: "",
      }).trim()
    : undefined;

  const openDialog = useCallback(() => {
    if (hasDetails) setDialogOpen(true);
  }, [hasDetails]);

  // 点击预览按钮：调用宿主注入的回调打开文件预览
  const handlePreviewFile = useCallback(() => {
    if (!previewPath || !onPreviewFile) return;
    onPreviewFile(previewPath);
  }, [onPreviewFile, previewPath]);

  return (
    <div>
      <div className={cn("tool-call-row-compact", isError && "is-error", isCanceled && "is-cancelled")}>
        <div className="chat-tool-call-row" data-kind={kind}>
          <span className="tool-call-row-icon" aria-hidden>
            {isRunning ? <Loader2 className="animate-spin" /> : <RowIcon />}
          </span>

          <span className={cn("tool-call-row-copy", showFileLink && "is-file-preview")}>
            <span className="tool-call-row-heading">
              {showFileLink ? (
                <span className="tool-call-row-title" title={titleText}>
                  <span>{withLoadingShimmer(fileAction, isRunning)} </span>
                  <button
                    type="button"
                    className="tool-call-row-file-link"
                    onClick={handlePreviewFile}
                    title={t("chat.components.toolCallRow.previewFile", { path: previewPath })}
                  >
                    {result.object}
                  </button>
                </span>
              ) : (
                <span className="tool-call-row-title" title={titleText}>
                  {withLoadingShimmer(result.title, isRunning)}
                </span>
              )}
              {result.subtitle ? (
                <span className="tool-call-row-meta">
                  <span className="truncate">{result.subtitle}</span>
                </span>
              ) : null}
            </span>
            {/* 错误信息独占第二行：源实现内联在标题行内，长错误会把标题挤到看不见 */}
            {result.errorDetail && (
              <span className="tool-call-row-error" title={result.errorDetail}>
                {result.errorDetail}
              </span>
            )}
          </span>

          <span className="tool-call-row-end">
            {result.badge && (
              <span
                className={cn(
                  "tool-call-row-duration text-[10px] shrink-0",
                  result.badge.tone === "success" && "text-emerald-600 dark:text-emerald-400",
                  result.badge.tone === "error" && "text-status-error",
                  result.badge.tone === "warn" && "text-amber-600 dark:text-amber-400",
                  result.badge.tone === "info" && "text-text-dim",
                )}
              >
                {result.badge.text}
              </span>
            )}
            {/* 完成态不渲染状态词（「Done / 已完成」是默认结果的噪音）；其余状态仍需明确提示 */}
            {!isComplete && (
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
            )}
          </span>

          {hasDetails && (
            <button
              type="button"
              className="chat-tool-call-row-details-button"
              onClick={openDialog}
              title={t("chat.components.toolCallRow.viewParams")}
              aria-label={t("chat.components.toolCallRow.viewParams")}
            >
              <CodeXml className="chat-tool-call-row-details-icon" aria-hidden />
            </button>
          )}
        </div>
      </div>

      {/* TodoWrite 仅展示相较上一轮的变更，完整清单由输入框上方的状态面板（ChatStatusPanel）承载。 */}
      {tool.todoChanges && <TodoChanges changes={tool.todoChanges} />}

      {/* 子 agent 嵌套面板（保留） */}
      {hasSubEntries && (
        <div className="mx-1 mt-1 mb-1 rounded-md border border-border/40 bg-surface-0/50">
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
          t={t}
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

/** 工具调用参数弹窗：展示原始入参/出参 JSON 与可读工具名。复制自 `packages/agent-runtime/web/components/chat/ToolCallRow.tsx`。 */
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
                {kindLabel(kind)
                  ? `${t("chat.components.toolCallRow.toolName")}: ${kindLabel(kind)}`
                  : t("chat.components.toolCallRow.toolName")}
              </span>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="px-4 py-3 space-y-3 max-h-[60vh] overflow-y-auto">
          {tool.rawInput && Object.keys(tool.rawInput).length > 0 && (
            <div>
              <div className="text-[9px] font-semibold uppercase tracking-widest text-text-dim mb-1.5">
                {t("chat.components.toolCallGroup.input")}
              </div>
              <pre className="tool-call-detail-code text-[11px] bg-surface-2 rounded-md px-3 py-2.5 overflow-auto font-mono text-text-secondary leading-relaxed">
                {truncate(JSON.stringify(tool.rawInput, null, 2), 3000)}
              </pre>
            </div>
          )}
          {hasOutput && (
            <div>
              <div className="text-[9px] font-semibold uppercase tracking-widest text-text-dim mb-1.5">
                {t("chat.components.toolCallGroup.output")}
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
          {isRunning && !hasOutput && (
            <p className="text-xs text-text-dim italic">{t("chat.components.toolCallRow.running")}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
