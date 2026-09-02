import type { AvailableCommand, SessionMode } from "@fenix/chat-channel";
import { Blocks, Paperclip, Plus, Send, Square } from "lucide-react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { ComposerContextMeter } from "./composer-context-meter";
import { SessionModeSelector } from "./SessionModeSelector";

interface ComposerToolbarProps {
  commands?: AvailableCommand[];
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
  const { t } = useTranslation("components");
  const showStop = canCancel || isCancelling;

  return (
    <div className="chat-composer-meta">
      <div className="chat-composer-meta-main">
        {(commands?.length ?? 0) + mcpCount > 0 ? (
          <button
            type="button"
            className="chat-composer-plugin"
            data-open={commandPanelOpen || undefined}
            aria-expanded={commandPanelOpen}
            disabled={disabled || isLoading}
            onClick={() => onCommandPanelOpenChange(!commandPanelOpen)}
          >
            <Blocks /> {t("chatComposer.commandButton")} <small>{(commands?.length ?? 0) + mcpCount}</small>
          </button>
        ) : null}

        <input ref={fileInputRef} type="file" multiple className="sr-only" onChange={onFileSelect} />
        <button
          type="button"
          className="chat-composer-icon-button chat-composer-file"
          disabled={disabled || !supportsAttachments}
          aria-label={t("chatComposer.attach")}
          title={t("chatComposer.attach")}
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip />
          <span>{t("chatComposer.fileButton")}</span>
        </button>

        <ComposerContextMeter usage={contextUsage} />
        {modelName ? (
          <span className="chat-composer-model" title={modelName}>
            {modelName}
          </span>
        ) : null}
        {availableModes?.length ? (
          <SessionModeSelector
            modes={availableModes}
            currentModeId={currentModeId ?? null}
            onModeChange={onModeChange ?? (() => {})}
            readOnly
          />
        ) : null}
      </div>
      <div className="chat-composer-meta-actions">
        {showNewSession && onNewSession ? (
          <Button type="button" variant="ghost" size="sm" onClick={onNewSession} className="chat-composer-new-session">
            <Plus /> {t("chatComposer.newSession")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={canCancel ? onInterrupt : onSubmit}
          disabled={isCancelling || (!canCancel && !canSend)}
          className={`chat-composer-send ${showStop ? "is-stop" : canSend ? "is-ready" : ""}`}
          aria-label={t(showStop ? "chatComposer.stop" : "chatComposer.send")}
        >
          {showStop ? <Square fill="currentColor" /> : <Send />}
        </Button>
      </div>
    </div>
  );
}
