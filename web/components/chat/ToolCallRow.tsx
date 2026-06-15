import { CodeXml, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolCallData } from "../../src/lib/types";
import { cn } from "../../src/lib/utils";
import { ToolPermissionButtons } from "../ai-elements/permission-request";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { SubAgentPanel } from "./SubAgentPanel";
import { ToolCardContent } from "./ToolCallContent";
import {
  CARD_STYLES,
  type CardStyle,
  formatOutput,
  getCardCategory,
  getToolIcon,
  simplifyToolName,
  truncate,
} from "./tool-call-utils";

// =============================================================================
// 单张工具卡片 — 每种工具有专属展示形式
// =============================================================================

interface ToolCallRowProps {
  tool: ToolCallData;
  onPermissionRespond?: (requestId: string, optionId: string | null, optionKind: string | null) => void;
}

export function ToolCallRow({ tool, onPermissionRespond }: ToolCallRowProps) {
  const { t } = useTranslation("components");
  const [dialogOpen, setDialogOpen] = useState(false);

  const cardCategory = getCardCategory(tool.title, tool.rawInput);
  const style = CARD_STYLES[cardCategory];
  const Icon = getToolIcon(tool.title, tool.rawInput);
  const toolName = simplifyToolName(tool.title);

  const isRunning = tool.status === "running";
  const isError = tool.status === "error";
  const isPending = tool.status === "waiting_for_confirmation";
  const isCanceled = tool.status === "canceled" || tool.status === "rejected";
  const hasSubEntries = (tool.subEntries?.length ?? 0) > 0;

  // 只要有 rawInput、rawOutput 或 content 就可以弹窗
  const hasParams =
    (tool.rawInput && Object.keys(tool.rawInput).length > 0) ||
    (!isRunning && !isPending && (tool.rawOutput || tool.content));

  const openDialog = useCallback(() => {
    if (hasParams && !isPending) setDialogOpen(true);
  }, [hasParams, isPending]);

  return (
    <div>
      {/* 卡片主体 — 仅展示，不可点击 */}
      <div
        className={cn(
          "flex items-center gap-3 px-3 py-2.5 rounded-lg",
          style.cardBg,
          isError && "ring-1 ring-inset ring-status-error/30",
          isCanceled && "opacity-50",
        )}
      >
        {/* 图标容器 — 彩色圆角方块 */}
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

        {/* 工具内容 — 按类型差异化渲染 */}
        <div className="flex-1 min-w-0">
          <ToolCardContent tool={tool} />
        </div>

        {/* 右侧状态 */}
        {isError && <span className="text-[10px] text-status-error font-medium shrink-0">失败</span>}
        {isPending && <span className="text-[10px] text-brand font-medium shrink-0">待确认</span>}

        {/* 参数弹窗按钮 — 点击打开入参出参弹窗 */}
        {hasParams && !isPending && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openDialog();
            }}
            className="h-6 w-6 rounded-md flex items-center justify-center shrink-0 text-text-dim hover:text-text-muted hover:bg-surface-2/80 transition-colors"
            title="查看参数"
          >
            <CodeXml className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* 子 agent 嵌套面板 */}
      {hasSubEntries && (
        <div className="max-h-64 overflow-y-auto mx-1 mt-1 mb-1 rounded-md border border-border/40 bg-surface-0/50">
          <div className="px-2 py-2">
            <SubAgentPanel entries={tool.subEntries!} />
          </div>
        </div>
      )}

      {/* 权限请求按钮 */}
      {isPending && tool.permissionRequest && (
        <div className="px-4 pb-2.5 pt-1" onClick={(e) => e.stopPropagation()}>
          <ToolPermissionButtons
            requestId={tool.permissionRequest.requestId}
            options={tool.permissionRequest.options}
            onRespond={onPermissionRespond || (() => {})}
          />
        </div>
      )}

      {/* 参数弹窗 */}
      {hasParams && (
        <ToolCallDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          tool={tool}
          toolName={toolName}
          style={style}
          t={t}
        />
      )}
    </div>
  );
}

// =============================================================================
// 参数弹窗 — 点击卡片后展示入参出参
// =============================================================================

interface ToolCallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tool: ToolCallData;
  toolName: string;
  style: CardStyle;
  t: (key: string) => string;
}

function ToolCallDialog({ open, onOpenChange, tool, toolName, style, t }: ToolCallDialogProps) {
  const Icon = getToolIcon(tool.title, tool.rawInput);
  const isError = tool.status === "error";
  const isRunning = tool.status === "running";
  const hasOutput = !isRunning && (tool.rawOutput || tool.content);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 gap-0">
        <DialogHeader className="px-4 py-3 border-b border-border">
          <DialogTitle className="text-sm font-medium flex items-center gap-2.5">
            <div className={cn("h-7 w-7 rounded-lg flex items-center justify-center", style.iconBg)}>
              <Icon className={cn("h-3.5 w-3.5", style.iconColor)} />
            </div>
            {toolName}
            <StatusDot status={tool.status} />
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

function StatusDot({ status }: { status: string }) {
  if (status === "running") return <Loader2 className="h-3 w-3 animate-spin text-status-running" />;
  if (status === "complete") return <span className="h-1.5 w-1.5 rounded-full bg-status-active/50" />;
  if (status === "error") return <span className="h-1.5 w-1.5 rounded-full bg-status-error" />;
  if (status === "waiting_for_confirmation")
    return <span className="h-1.5 w-1.5 rounded-full bg-brand animate-pulse" />;
  return null;
}
