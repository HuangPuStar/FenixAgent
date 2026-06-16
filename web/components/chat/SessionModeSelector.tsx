import { Check, ChevronDown, ChevronUp, Shield } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionMode } from "../../src/acp/types";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

interface SessionModeSelectorProps {
  modes: SessionMode[];
  currentModeId: string | null;
  onModeChange: (modeId: string) => void;
}

/**
 * Session Mode Selector — 从 agent 动态获取的会话模式下拉选择器。
 *
 * 当 modes 为空时返回 null（不渲染任何内容），避免在无模式数据时占据布局空间。
 * 被提取为独立组件以便后续 ChatComposer 复用。
 */
export function SessionModeSelector({ modes, currentModeId, onModeChange }: SessionModeSelectorProps) {
  const { t } = useTranslation("components");
  const [open, setOpen] = useState(false);
  const current = modes.find((m) => m.id === currentModeId) ?? modes[0];

  if (modes.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground h-7 px-2">
          <Shield className="h-3 w-3" />
          <span className="max-w-24 truncate">{current?.name ?? t("sessionModeSelector.default")}</span>
          {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="start">
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => {
              onModeChange(m.id);
              setOpen(false);
            }}
            className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-surface-2 transition-colors"
          >
            <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center">
              {currentModeId === m.id && <Check className="h-3.5 w-3.5 text-brand" />}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text-primary">{m.name}</div>
              {m.description && <div className="text-xs text-text-muted">{m.description}</div>}
            </div>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
