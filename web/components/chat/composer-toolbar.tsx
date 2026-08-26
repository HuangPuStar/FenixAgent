import type { AvailableCommand, SessionMode } from "@fenix/chat-channel";
import { Blocks, Paperclip, Plus, Send, Square } from "lucide-react";
import { type RefObject, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { CommandMenu } from "./CommandMenu";
import { ComposerContextMeter } from "./composer-context-meter";
import { SessionModeSelector } from "./SessionModeSelector";

interface ComposerToolbarProps {
  commands?: AvailableCommand[];
  disabled: boolean;
  isLoading: boolean;
  canCancel: boolean;
  isCancelling: boolean;
  canSend: boolean;
  supportsAttachments: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileSelect: () => void;
  onCommandSelect: (command: AvailableCommand) => void;
  contextUsage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } | null;
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
  disabled,
  isLoading,
  canCancel,
  isCancelling,
  canSend,
  supportsAttachments,
  fileInputRef,
  onFileSelect,
  onCommandSelect,
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
  const [pluginOpen, setPluginOpen] = useState(false);
  const showStop = canCancel || isCancelling;

  return (
    <div className="chat-composer-meta flex items-center gap-2 px-4 py-2.5 text-[11px]">
      {commands?.length ? (
        <Popover open={pluginOpen} onOpenChange={setPluginOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="chat-composer-plugin" disabled={disabled || isLoading}>
              <Blocks /> {t("chatComposer.commandButton")} <small>{commands.length}</small>
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" sideOffset={8} className="w-[min(640px,calc(100vw-2rem))] p-0">
            <CommandMenu
              commands={commands}
              filter=""
              showSearch
              className="!rounded-none !border-0 !bg-transparent !shadow-none"
              onSelect={(command) => {
                onCommandSelect(command);
                setPluginOpen(false);
              }}
              onClose={() => setPluginOpen(false)}
            />
          </PopoverContent>
        </Popover>
      ) : null}

      <input ref={fileInputRef} type="file" multiple className="sr-only" onChange={onFileSelect} />
      <button
        type="button"
        className="chat-composer-icon-button"
        disabled={disabled || !supportsAttachments}
        aria-label={t("chatComposer.attach")}
        title={t("chatComposer.attach")}
        onClick={() => fileInputRef.current?.click()}
      >
        <Paperclip />
      </button>

      <ComposerContextMeter usage={contextUsage} />
      {availableModes?.length ? (
        <SessionModeSelector
          modes={availableModes}
          currentModeId={currentModeId ?? null}
          onModeChange={onModeChange ?? (() => {})}
          readOnly
        />
      ) : null}
      {modelName ? (
        <span className="max-w-[120px] truncate px-2 text-xs text-muted-foreground" title={modelName}>
          {modelName}
        </span>
      ) : null}
      <div className="flex-1" />
      {showNewSession && onNewSession ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onNewSession}
          className="h-7 gap-1 px-2 text-[11px] text-text-muted"
        >
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
  );
}
