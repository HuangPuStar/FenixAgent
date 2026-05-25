import { SendHorizonal, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { cn, isClosedSessionStatus } from "../lib/utils";

interface ControlBarProps {
  sessionId: string;
  sessionStatus: string | null;
  activityMode: string;
  onSend: (text: string) => Promise<void>;
  onInterrupt: () => Promise<void>;
}

export function ControlBar({
  sessionId: _sessionId,
  sessionStatus,
  activityMode,
  onSend,
  onInterrupt,
}: ControlBarProps) {
  const { t } = useTranslation("components");
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const closed = isClosedSessionStatus(sessionStatus);
  const working = activityMode === "working";

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || closed) return;
    setText("");
    try {
      await onSend(trimmed);
    } catch {
      setText(trimmed);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent?.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="border-t border-border bg-surface-1 px-4 py-3">
      <div className="mx-auto flex max-w-5xl items-center gap-2">
        <Input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={closed ? t("controlBar.sessionClosed") : t("controlBar.typeMessage")}
          disabled={closed}
          className="flex-1 rounded-lg border border-border bg-surface-2 px-4 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand/20 disabled:opacity-50 transition-colors"
        />
        <Button
          onClick={working ? onInterrupt : handleSend}
          disabled={closed}
          variant="ghost"
          size="icon"
          className={cn(
            "h-10 w-10",
            working
              ? "bg-status-error/20 text-status-error hover:bg-status-error/30"
              : "bg-brand text-white hover:bg-brand-light",
            closed && "opacity-50 cursor-not-allowed",
          )}
          aria-label={working ? t("controlBar.stop") : t("controlBar.send")}
          title={closed ? t("controlBar.sessionClosed") : working ? t("controlBar.stop") : t("controlBar.send")}
        >
          {working ? (
            <Square className="h-4.5 w-4.5 fill-current" />
          ) : (
            <SendHorizonal className="h-5 w-5 fill-current" />
          )}
        </Button>
      </div>
    </div>
  );
}
