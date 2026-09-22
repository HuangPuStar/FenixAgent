import { Blocks, Paperclip, Plus, Send, Square } from "lucide-react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { Button } from "../../ui/button";
import { simplifyModelDisplayName } from "../lib/simplify-model-display-name";
import type { AvailableCommand, SessionMode } from "../types";
import { ComposerContextMeter } from "./composer-context-meter";
import { SessionModeSelector } from "./SessionModeSelector";

/**
 * Composer 底部操作行。
 *
 * 来源：复制自 `packages/agent-runtime/web/components/chat/composer-toolbar.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 * 纯化改动点：`@fenix/chat-channel` 类型 → 包内 `../types`；`@/components/ui/button` →
 * `../../ui/button`；`@/src/lib/model-config-utils` 的 `simplifyModelDisplayName` →
 * 包内纯函数 `../lib/simplify-model-display-name`；命名空间改为 `UI_COMPONENTS_NS`
 * （键 `chat.components.chatComposer.*`）；插件菜单只展示 Agent 实际公布的命令，结构逐字保留。
 */

interface ComposerToolbarProps {
  commands?: readonly AvailableCommand[];
  mcpCount?: number;
  disabled: boolean;
  isLoading: boolean;
  canCancel: boolean;
  isCancelling: boolean;
  canSend: boolean;
  supportsAttachments: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileSelect: () => void;
  commandPanelOpen: boolean;
  onCommandPanelOpenChange: (open: boolean) => void;
  contextUsage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number; contextWindow?: number } | null;
  availableModes?: SessionMode[];
  currentModeId?: string | null;
  onModeChange?: (modeId: string) => void;
  modelName?: string;
  showNewSession?: boolean;
  onNewSession?: () => void;
  onSubmit: () => void;
  onInterrupt?: () => void;
}

/** Composer 底部操作行；插件菜单只展示 Agent 实际公布的命令。 */
export function ComposerToolbar({
  commands,
  mcpCount = 0,
  disabled,
  isLoading,
  canCancel,
  isCancelling,
  canSend,
  supportsAttachments,
  fileInputRef,
  onFileSelect,
  commandPanelOpen,
  onCommandPanelOpenChange,
  contextUsage,
  availableModes,
  currentModeId,
  onModeChange,
  modelName,
  showNewSession,
  onNewSession,
  onSubmit,
  onInterrupt,
}: ComposerToolbarProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const showStop = canCancel || isCancelling;

  return (
    <div className="flex min-h-[44px] min-w-0 items-center gap-2.5 px-2.5 pt-[5px] pb-[7px]">
      <div className="flex min-w-0 items-center gap-[3px] overflow-hidden">
        {(commands?.length ?? 0) + mcpCount > 0 ? (
          <button
            type="button"
            className="inline-flex h-7 shrink-0 items-center gap-[5px] rounded-md px-1.5 text-[#69768a] hover:bg-[#f1f5fa] hover:text-[#2f5ea9] data-[open]:text-[#315a9f]"
            data-open={commandPanelOpen || undefined}
            data-slot="chat-composer-plugin"
            aria-expanded={commandPanelOpen}
            disabled={disabled || isLoading}
            onClick={() => onCommandPanelOpenChange(!commandPanelOpen)}
          >
            <Blocks className="h-[15px] w-[15px]" /> {t("chat.components.chatComposer.skillButton")}{" "}
            <small className="text-[10px] text-[#94a0b2]">{(commands?.length ?? 0) + mcpCount}</small>
          </button>
        ) : null}

        <input ref={fileInputRef} type="file" multiple className="sr-only" onChange={onFileSelect} />
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center gap-[5px] rounded-md px-1.5 text-[#69768a] hover:bg-[#f1f5fa] hover:text-[#2f5ea9]"
          data-slot="chat-composer-file"
          disabled={disabled || !supportsAttachments}
          aria-label={t("chat.components.chatComposer.attach")}
          title={t("chat.components.chatComposer.attach")}
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip className="h-[15px] w-[15px]" />
          <span className="[@media(max-width:720px)]:hidden">{t("chat.components.chatComposer.fileButton")}</span>
        </button>

        {modelName ? (
          <span
            className="inline-flex h-7 max-w-[124px] min-w-0 items-center gap-[5px] overflow-hidden px-[7px] text-[11px] leading-none text-ellipsis whitespace-nowrap text-[#7b8799] [@media(max-width:720px)]:max-w-[92px]"
            data-slot="chat-composer-model"
            title={modelName}
          >
            {simplifyModelDisplayName(modelName)}
          </span>
        ) : null}
        <ComposerContextMeter usage={contextUsage} />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-[5px]" data-slot="chat-composer-meta-actions">
        {availableModes?.length ? (
          <SessionModeSelector
            modes={availableModes}
            currentModeId={currentModeId ?? null}
            onModeChange={onModeChange ?? (() => {})}
            readOnly
          />
        ) : null}
        {showNewSession && onNewSession ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onNewSession}
            className="h-7 gap-1 px-[7px] text-[11px] text-[#718096] has-[>svg]:px-[7px]"
          >
            <Plus className="size-3.5" /> {t("chat.components.chatComposer.newSession")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={canCancel ? onInterrupt : onSubmit}
          disabled={isCancelling || (!canCancel && !canSend)}
          className={`grid h-[34px] w-[34px] place-items-center rounded-[10px] p-0 has-[>svg]:p-0 ${
            showStop ? "bg-brand text-white" : canSend ? "bg-[#2f6fe4] text-white" : "bg-[#e8edf4] text-[#9aa6b7]"
          }`}
          data-slot="chat-composer-send"
          aria-label={t(showStop ? "chat.components.chatComposer.stop" : "chat.components.chatComposer.send")}
        >
          {showStop ? <Square fill="currentColor" /> : <Send />}
        </Button>
      </div>
    </div>
  );
}
