import type { AvailableCommand } from "@fenix/chat-channel";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
function commandMatches(query: string, command: AvailableCommand): boolean {
  if (!query) return true;
  const normalizedQuery = query.toLowerCase();
  return (
    command.name.toLowerCase().includes(normalizedQuery) || command.description.toLowerCase().includes(normalizedQuery)
  );
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
    return commands.filter((command) => commandMatches(effectiveFilter, command));
  }, [commands, effectiveFilter]);

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
        setActiveIndex((prev) => {
          const next = (prev + 1) % filtered.length;
          requestAnimationFrame(() =>
            containerRef.current?.querySelector("[data-active='true']")?.scrollIntoView({ block: "nearest" }),
          );
          return next;
        });
      } else if (e.key === "ArrowUp") {
        setActiveIndex((prev) => {
          const next = (prev - 1 + filtered.length) % filtered.length;
          requestAnimationFrame(() =>
            containerRef.current?.querySelector("[data-active='true']")?.scrollIntoView({ block: "nearest" }),
          );
          return next;
        });
      } else if (e.key === "Enter") {
        const cmd = filtered[activeIndex];
        if (cmd) onSelect(cmd);
      }
    };

    document.addEventListener("keydown", handleKeyDown, true); // capture phase
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [filtered, activeIndex, onSelect]);

  return (
    <div ref={containerRef} className={`chat-command-menu${className ? ` ${className}` : ""}`}>
      {showSearch && (
        <div className="chat-command-menu-search">
          <Search />
          <Input
            type="text"
            placeholder={t("commandMenu.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setActiveIndex(0);
            }}
            className="chat-command-menu-input"
            autoFocus
          />
        </div>
      )}
      <ScrollArea className="chat-command-menu-scroll">
        <div className="chat-command-menu-list">
          {filtered.length === 0 ? (
            <div className="chat-command-menu-empty">{t("commandMenu.noMatch")}</div>
          ) : (
            filtered.map((cmd, index) => (
              <button
                key={cmd.name}
                type="button"
                data-active={index === activeIndex}
                onClick={() => onSelect(cmd)}
                onMouseEnter={() => setActiveIndex(index)}
                className={`chat-command-menu-item${index === activeIndex ? " is-active" : ""}`}
              >
                <span className="chat-command-menu-name">/{cmd.name}</span>
                <span className="chat-command-menu-description">{cmd.description}</span>
                {cmd.input?.hint && <span className="chat-command-menu-hint">{cmd.input.hint}</span>}
              </button>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
