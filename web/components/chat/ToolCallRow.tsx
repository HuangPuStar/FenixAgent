import { CodeXml, ExternalLink, Loader2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "../../src/i18n";
import type { ToolCallData } from "../../src/lib/types";
import { cn } from "../../src/lib/utils";
import { ToolPermissionButtons } from "../ai-elements/permission-request";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { narrate } from "./narrators";
import { SubAgentPanel } from "./SubAgentPanel";
import { CARD_STYLES, formatOutput, getCardCategory, simplifyToolName, truncate } from "./tool-call-utils";

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
  onPermissionRespond?: (requestId: string, optionId: string | null, optionKind: string | null) => void;
}

export function ToolCallRow({ tool, onPermissionRespond }: ToolCallRowProps) {
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

  // 卡片颜色继续走现有逻辑（避免一次性改太多）
  const cardCategory = getCardCategory(tool.title, tool.rawInput, tool.display?.type);
  const style = CARD_STYLES[cardCategory];
  const Icon = result.icon ?? Loader2;

  const isRunning = tool.status === "running";
  const isError = tool.status === "error";
  const isPending = tool.status === "waiting_for_confirmation";
  const isCanceled = tool.status === "canceled" || tool.status === "rejected";
  const hasSubEntries = (tool.subEntries?.length ?? 0) > 0;

  const hasParams =
    (tool.rawInput && Object.keys(tool.rawInput).length > 0) ||
    (!isRunning && !isPending && (tool.rawOutput || tool.content));

  // 检测工具入参中是否包含文件路径，用于显示预览按钮
  // 优先使用 display.path（引擎提供的真实文件路径），兜底走 rawInput
  const previewPath = tool.display?.path ?? extractPreviewPath(tool.rawInput);

  const openDialog = useCallback(() => {
    if (hasParams && !isPending) setDialogOpen(true);
  }, [hasParams, isPending]);

  // 点击预览按钮：发送事件通知 ArtifactsPanel 展开并打开文件预览
  const handlePreviewFile = useCallback(() => {
    if (!previewPath) return;
    window.dispatchEvent(new CustomEvent("artifacts:preview-file", { detail: { path: previewPath } }));
  }, [previewPath]);

  return (
    <div>
      {/* 卡片主体 */}
      <div
        className={cn(
          "flex items-center gap-3 px-3 py-2.5 rounded-lg",
          style.cardBg,
          isError && "ring-1 ring-inset ring-status-error/30",
          isCanceled && "opacity-50",
        )}
      >
        {/* 图标 */}
        <div
          className={cn(
            "h-10 w-10 rounded-xl flex items-center justify-center shrink-0",
            style.iconBg,
            isRunning && "animate-pulse",
          )}
        >
          {isRunning ? (
            <Loader2 className={cn("h-[18px] w-[18px] animate-spin", style.iconColor)} />
          ) : (
            <Icon className={cn("h-[18px] w-[18px]", style.iconColor)} />
          )}
        </div>

        {/* 工具内容 — 渲染 narrate 结果 */}
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-text-primary truncate">{result.title}</div>
          <div className="text-[11px] text-text-dim mt-0.5 truncate flex items-center gap-1.5">
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
          </div>
          {/* 错误细节单独一行 */}
          {result.errorDetail && (
            <div className="text-[10px] text-status-error/80 mt-0.5 truncate" title={result.errorDetail}>
              {result.errorDetail}
            </div>
          )}
        </div>

        {/* 右侧状态标签 */}
        <span
          className={cn(
            "text-[10px] font-medium shrink-0",
            isError && "text-status-error",
            isPending && "text-brand",
            isCanceled && "text-text-dim",
            !isError && !isPending && !isCanceled && "text-text-dim",
          )}
        >
          {result.statusLabel}
        </span>

        {/* 文件预览按钮：仅当工具入参包含文件路径时显示 */}
        {previewPath && !isPending && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handlePreviewFile();
            }}
            className="h-6 px-2 gap-1 rounded-md flex items-center shrink-0 text-xs text-blue-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
            title={tComponents("toolCallRow.previewFile", { path: previewPath })}
          >
            <ExternalLink className="h-3 w-3" />
            <span>{tComponents("toolCallRow.openFile", "打开文件")}</span>
          </button>
        )}

        {/* 参数弹窗按钮 */}
        {hasParams && !isPending && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openDialog();
            }}
            className="h-6 w-6 rounded-md flex items-center justify-center shrink-0 text-text-dim hover:text-text-muted hover:bg-surface-2/80 transition-colors"
            title={tComponents("toolCallRow.viewParams")}
          >
            <CodeXml className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* 子 agent 嵌套面板（保留） */}
      {hasSubEntries && (
        <div className="max-h-64 overflow-y-auto mx-1 mt-1 mb-1 rounded-md border border-border/40 bg-surface-0/50">
          <div className="px-2 py-2">
            <SubAgentPanel entries={tool.subEntries!} />
          </div>
        </div>
      )}

      {/* 权限请求按钮（保留） */}
      {isPending && tool.permissionRequest && (
        <div className="px-4 pb-2.5 pt-1" onClick={(e) => e.stopPropagation()}>
          <ToolPermissionButtons
            requestId={tool.permissionRequest.requestId}
            options={tool.permissionRequest.options}
            onRespond={onPermissionRespond || (() => {})}
          />
        </div>
      )}

      {/* 参数弹窗（保留） */}
      {hasParams && (
        <ToolCallDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          tool={tool}
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
  style: { iconBg: string; iconColor: string };
  icon: React.ComponentType<{ className?: string }>;
  title: React.ReactNode;
  t: (key: string) => string;
}

function ToolCallDialog({ open, onOpenChange, tool, style, icon: Icon, title, t }: ToolCallDialogProps) {
  const isError = tool.status === "error";
  const isRunning = tool.status === "running";
  const hasOutput = !isRunning && (tool.rawOutput || tool.content);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 gap-0">
        <DialogHeader className="px-4 py-3 border-b border-border">
          <DialogTitle className="text-sm font-medium flex items-center gap-2.5">
            <div className={cn("h-7 w-7 rounded-lg flex items-center justify-center shrink-0", style.iconBg)}>
              <Icon className={cn("h-3.5 w-3.5", style.iconColor)} />
            </div>
            {/* 主标题为人性化句子；下方附原始工具名，便于用户识别工具类型 */}
            <div className="flex flex-col min-w-0 gap-0.5">
              <span className="truncate">{title}</span>
              <span className="text-[10px] text-text-dim font-mono truncate leading-tight">
                {t("toolCallRow.toolName")}: {simplifyToolName(tool.title)}
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
          {isRunning && !hasOutput && <p className="text-xs text-text-dim italic">工具正在执行中...</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
