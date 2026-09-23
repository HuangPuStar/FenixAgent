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
    <div className="flex min-h-11 min-w-0 items-center gap-2.5 px-2.5 pt-1.25 pb-1.75">
      <div className="flex min-w-0 items-center gap-0.75 overflow-hidden">
        {(commands?.length ?? 0) + mcpCount > 0 ? (
          <button
            type="button"
            className="inline-flex h-7 text-xs shrink-0 items-center gap-1.25 rounded-md px-1.5 text-slate-500 hover:bg-slate-100 hover:text-sky-700 data-[open]:text-blue-900"
            data-open={commandPanelOpen || undefined}
            data-slot="chat-composer-plugin"
            aria-expanded={commandPanelOpen}
            disabled={disabled || isLoading}
            onClick={() => onCommandPanelOpenChange(!commandPanelOpen)}
          >
            <Blocks className="h-3.75 w-3.75" /> {t("chat.components.chatComposer.skillButton")}{" "}
            <small className="text-3xs text-gray-400">{(commands?.length ?? 0) + mcpCount}</small>
          </button>
        ) : null}

        <input ref={fileInputRef} type="file" multiple className="sr-only" onChange={onFileSelect} />
        <button
          type="button"
          className="inline-flex h-7 text-xs shrink-0 items-center gap-1.25 rounded-md px-1.5 text-slate-500 hover:bg-slate-100 hover:text-sky-700"
          data-slot="chat-composer-file"
          disabled={disabled || !supportsAttachments}
          aria-label={t("chat.components.chatComposer.attach")}
          title={t("chat.components.chatComposer.attach")}
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip className="h-3.75 w-3.75" />
          <span className="max-md:hidden">{t("chat.components.chatComposer.fileButton")}</span>
        </button>

        {modelName ? (
          <span
            className="inline-flex h-7 min-w-0 items-center gap-1.25 overflow-hidden px-1.75 text-3xs leading-none text-ellipsis whitespace-nowrap text-slate-500 max-md:max-w-23"
            data-slot="chat-composer-model"
            title={modelName}
          >
            {simplifyModelDisplayName(modelName)}
          </span>
        ) : null}
        <ComposerContextMeter usage={contextUsage} />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.25" data-slot="chat-composer-meta-actions">
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
            className="h-7 gap-1 px-1.75 text-3xs text-slate-500 has-[>svg]:px-1.75"
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
          className={`grid h-8.5 w-8.5 place-items-center rounded-lg p-0 has-[>svg]:p-0 ${
            showStop ? "bg-brand text-white" : canSend ? "bg-blue-500 text-white" : "bg-slate-200 text-gray-400"
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
