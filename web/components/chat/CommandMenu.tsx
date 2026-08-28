import type { AvailableCommand } from "@fenix/chat-channel";
import { CheckCircle2, Plug, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";

export interface McpOption {
  id: string;
  name: string;
  description: string;
}

interface CommandMenuProps {
  commands: AvailableCommand[];
  mcps?: McpOption[];
  selectedCommandNames?: ReadonlySet<string>;
  selectedMcpIds?: ReadonlySet<string>;
  /** Text after "/" used for filtering. */
  filter: string;
  onSelect: (command: AvailableCommand) => void;
  onToggleMcp?: (mcp: McpOption) => void;
  onClose: () => void;
  className?: string;
  /** Toolbar mode owns a search input; slash mode keeps focus in the textarea. */
  showSearch?: boolean;
}

function commandMatches(query: string, command: AvailableCommand): boolean {
  if (!query) return true;
  const normalizedQuery = query.toLowerCase();
  return (
    command.name.toLowerCase().includes(normalizedQuery) || command.description.toLowerCase().includes(normalizedQuery)
  );
}

/**
 * Slash mode renders command results only. Toolbar mode renders selectable Skills
 * and Agent-bound MCP connections without changing the textarea draft.
 */
export function CommandMenu({
  commands,
  mcps = [],
  selectedCommandNames = new Set<string>(),
  selectedMcpIds = new Set<string>(),
  filter,
  onSelect,
  onToggleMcp,
  onClose,
  className,
  showSearch,
}: CommandMenuProps) {
  const { t } = useTranslation("components");
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const effectiveFilter = showSearch ? searchQuery : filter;

  const filteredCommands = useMemo(() => {
    if (!effectiveFilter) return commands;
    return commands.filter((command) => commandMatches(effectiveFilter, command));
  }, [commands, effectiveFilter]);

  const filteredMcps = useMemo(() => {
    if (!effectiveFilter) return mcps;
    const query = effectiveFilter.toLowerCase();
    return mcps.filter(
      (mcp) => mcp.name.toLowerCase().includes(query) || mcp.description.toLowerCase().includes(query),
    );
  }, [effectiveFilter, mcps]);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter") {
        if (event.shiftKey && event.key === "Enter") return;
        event.preventDefault();
        event.stopPropagation();
      }
      if (filteredCommands.length === 0) return;

      if (event.key === "ArrowDown") {
        setActiveIndex((current) => (current + 1) % filteredCommands.length);
      } else if (event.key === "ArrowUp") {
        setActiveIndex((current) => (current - 1 + filteredCommands.length) % filteredCommands.length);
      } else if (event.key === "Enter") {
        const command = filteredCommands[activeIndex];
        if (command) onSelect(command);
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [activeIndex, filteredCommands, onSelect]);

  const empty = filteredCommands.length === 0 && filteredMcps.length === 0;

  return (
    <div ref={containerRef} className={`chat-command-menu${className ? ` ${className}` : ""}`}>
      {showSearch && (
        <div className="chat-command-menu-search">
          <Search />
          <Input
            type="text"
            placeholder={t("commandMenu.searchPlaceholder")}
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setActiveIndex(0);
            }}
            className="chat-command-menu-input"
            autoFocus
          />
        </div>
      )}
      <ScrollArea className="chat-command-menu-scroll">
        <div className="chat-command-menu-list">
          {empty ? (
            <div className="chat-command-menu-empty">{t("commandMenu.noMatch")}</div>
          ) : (
            <>
              {filteredCommands.length > 0 && (
                <section className="chat-command-menu-section">
                  {showSearch && (
                    <div className="chat-command-menu-section-title">
                      <strong>{t("commandMenu.skills")}</strong>
                      <span>{t("commandMenu.skillsCaption")}</span>
                    </div>
                  )}
                  {filteredCommands.map((command, index) => {
                    const selected = selectedCommandNames.has(command.name);
                    return (
                      <button
                        key={command.name}
                        type="button"
                        data-active={index === activeIndex}
                        aria-pressed={selected}
                        onClick={() => onSelect(command)}
                        onMouseEnter={() => setActiveIndex(index)}
                        className={`chat-command-menu-item${index === activeIndex ? " is-active" : ""}${selected ? " is-selected" : ""}`}
                      >
                        <span className="chat-command-menu-name">/{command.name}</span>
                        <span className="chat-command-menu-description">{command.description}</span>
                        {command.input?.hint && <span className="chat-command-menu-hint">{command.input.hint}</span>}
                        {selected && <CheckCircle2 className="chat-command-menu-check" />}
                      </button>
                    );
                  })}
                </section>
              )}
              {showSearch && filteredMcps.length > 0 && (
                <section className="chat-command-menu-section">
                  <div className="chat-command-menu-section-title">
                    <strong>{t("commandMenu.mcps")}</strong>
                    <span>{t("commandMenu.mcpsCaption")}</span>
                  </div>
                  {filteredMcps.map((mcp) => {
                    const selected = selectedMcpIds.has(mcp.id);
                    return (
                      <button
                        key={mcp.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onToggleMcp?.(mcp)}
                        className={`chat-command-menu-item chat-command-menu-mcp${selected ? " is-selected" : ""}`}
                      >
                        <Plug className="chat-command-menu-mcp-icon" />
                        <span className="chat-command-menu-name">{mcp.name}</span>
                        <span className="chat-command-menu-description">{mcp.description}</span>
                        <em className="chat-command-menu-mcp-state">{t("commandMenu.connected")}</em>
                      </button>
                    );
                  })}
                </section>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
