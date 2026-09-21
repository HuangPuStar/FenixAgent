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
 * 来源：复制自 `packages/agent-runtime/web/components/chat/composer-toolbar.tsx`。
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
            <Blocks /> {t("chat.components.chatComposer.skillButton")}{" "}
            <small>{(commands?.length ?? 0) + mcpCount}</small>
          </button>
        ) : null}

        <input ref={fileInputRef} type="file" multiple className="sr-only" onChange={onFileSelect} />
        <button
          type="button"
          className="chat-composer-icon-button chat-composer-file"
          disabled={disabled || !supportsAttachments}
          aria-label={t("chat.components.chatComposer.attach")}
          title={t("chat.components.chatComposer.attach")}
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip />
          <span>{t("chat.components.chatComposer.fileButton")}</span>
        </button>

        {modelName ? (
          <span className="chat-composer-model" title={modelName}>
            {simplifyModelDisplayName(modelName)}
          </span>
        ) : null}
        <ComposerContextMeter usage={contextUsage} />
      </div>
      <div className="chat-composer-meta-actions">
        {availableModes?.length ? (
          <SessionModeSelector
            modes={availableModes}
            currentModeId={currentModeId ?? null}
            onModeChange={onModeChange ?? (() => {})}
            readOnly
          />
        ) : null}
        {showNewSession && onNewSession ? (
          <Button type="button" variant="ghost" size="sm" onClick={onNewSession} className="chat-composer-new-session">
            <Plus /> {t("chat.components.chatComposer.newSession")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={canCancel ? onInterrupt : onSubmit}
          disabled={isCancelling || (!canCancel && !canSend)}
          className={`chat-composer-send ${showStop ? "is-stop" : canSend ? "is-ready" : ""}`}
          aria-label={t(showStop ? "chat.components.chatComposer.stop" : "chat.components.chatComposer.send")}
        >
          {showStop ? <Square fill="currentColor" /> : <Send />}
        </Button>
      </div>
    </div>
  );
}
