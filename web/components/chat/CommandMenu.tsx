import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AvailableCommand } from "../../src/acp/types";
import { cn } from "../../src/lib/utils";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";

// =============================================================================
// Slash command picker — floating above ChatInput
// =============================================================================

interface CommandMenuProps {
  commands: AvailableCommand[];
  /** Text after "/" used for filtering */
  filter: string;
  onSelect: (command: AvailableCommand) => void;
  onClose: () => void;
  className?: string;
  /** 是否显示搜索框（用于 Popover 场景独立搜索，不依赖 textarea 输入） */
  showSearch?: boolean;
}

/**
 * Prefix match — checks if the text starts with the query.
 */
function prefixMatch(query: string, text: string): boolean {
  if (!query) return true;
  return text.toLowerCase().startsWith(query.toLowerCase());
}

export function CommandMenu({ commands, filter, onSelect, onClose, className, showSearch }: CommandMenuProps) {
  const { t } = useTranslation("components");
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");

  // 合并搜索：showSearch 时用内部 searchQuery，否则用外部 filter
  const effectiveFilter = showSearch ? searchQuery : filter;

  // Filter commands by current input
  const filtered = useMemo(() => {
    if (!effectiveFilter) return commands;
    return commands.filter((cmd) => prefixMatch(effectiveFilter, cmd.name));
  }, [commands, effectiveFilter]);

  // Reset active index when filter changes
  useEffect(() => {
    setActiveIndex(0);
  }, []);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  // Handle keyboard navigation (ArrowUp/ArrowDown/Enter) via document-level listener
  // Uses capture phase + stopPropagation to prevent events from reaching the textarea
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Always intercept these keys when menu is open, even with no filtered results
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") {
        if (e.shiftKey && e.key === "Enter") return; // allow Shift+Enter for newline
        e.preventDefault();
        e.stopPropagation();
      }

      if (filtered.length === 0) return;

      if (e.key === "ArrowDown") {
        setActiveIndex((prev) => (prev + 1) % filtered.length);
      } else if (e.key === "ArrowUp") {
        setActiveIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
      } else if (e.key === "Enter") {
        const cmd = filtered[activeIndex];
        if (cmd) onSelect(cmd);
      }
    };

    document.addEventListener("keydown", handleKeyDown, true); // capture phase
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [filtered, activeIndex, onSelect]);

  // Scroll active item into view
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const active = container.querySelector("[data-active='true']");
    active?.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <div ref={containerRef} className={cn("rounded-xl border border-border bg-surface-2 shadow-lg", className)}>
      {/* 搜索框：Popover 场景下独立搜索 */}
      {showSearch && (
        <div className="flex items-center gap-2 px-4 pt-3 pb-2">
          <Search className="h-4 w-4 text-text-muted flex-shrink-0" />
          <Input
            type="text"
            placeholder={t("commandMenu.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 rounded-lg border border-border bg-surface-1 px-2 py-1.5 text-sm"
          />
        </div>
      )}
      <ScrollArea className="h-[320px]">
        <div className="py-1">
          {filtered.length === 0 ? (
            <div className="text-xs text-text-muted font-display py-3 text-center">{t("commandMenu.noMatch")}</div>
          ) : (
            filtered.map((cmd, index) => (
              <button
                key={cmd.name}
                type="button"
                data-active={index === activeIndex}
                onClick={() => onSelect(cmd)}
                onMouseEnter={() => setActiveIndex(index)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 cursor-pointer rounded-lg mx-1 text-left",
                  "transition-colors",
                  index === activeIndex ? "bg-brand/10 text-text-primary" : "text-text-secondary hover:bg-surface-1/50",
                )}
                style={{ width: "calc(100% - 8px)" }}
              >
                <span className="text-sm font-display font-medium text-brand">/{cmd.name}</span>
                <span className="text-xs text-text-muted truncate flex-1">{cmd.description}</span>
                {cmd.input?.hint && <span className="text-[10px] text-text-muted italic">{cmd.input.hint}</span>}
              </button>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
