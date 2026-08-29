import type { AvailableCommand } from "@fenix/chat-channel";
import { CheckCircle2, Plug, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { useRovingListNavigation } from "../ui/use-roving-list-navigation";

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

  const navigationKeys = useMemo(
    () => [
      ...filteredCommands.map((command) => `skill:${command.name}`),
      ...filteredMcps.map((mcp) => `mcp:${mcp.id}`),
    ],
    [filteredCommands, filteredMcps],
  );
  const handleNavigationSelect = useCallback(
    (key: string) => {
      if (key.startsWith("skill:")) {
        const command = filteredCommands.find((item) => `skill:${item.name}` === key);
        if (command) onSelect(command);
        return;
      }
      const mcp = filteredMcps.find((item) => `mcp:${item.id}` === key);
      if (mcp) onToggleMcp?.(mcp);
    },
    [filteredCommands, filteredMcps, onSelect, onToggleMcp],
  );
  const { activeKey, setActiveKey, registerItem, handleKeyDown } = useRovingListNavigation({
    itemKeys: navigationKeys,
    onSelect: handleNavigationSelect,
  });

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);

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
            onChange={(event) => setSearchQuery(event.target.value)}
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
                  {filteredCommands.map((command) => {
                    const navigationKey = `skill:${command.name}`;
                    const active = navigationKey === activeKey;
                    const selected = selectedCommandNames.has(command.name);
                    return (
                      <button
                        ref={registerItem(navigationKey)}
                        key={command.name}
                        type="button"
                        data-active={active}
                        aria-pressed={selected}
                        onClick={() => onSelect(command)}
                        onMouseEnter={() => setActiveKey(navigationKey)}
                        className={`chat-command-menu-item${active ? " is-active" : ""}${selected ? " is-selected" : ""}`}
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
                    const navigationKey = `mcp:${mcp.id}`;
                    const active = navigationKey === activeKey;
                    const selected = selectedMcpIds.has(mcp.id);
                    return (
                      <button
                        ref={registerItem(navigationKey)}
                        key={mcp.id}
                        type="button"
                        data-active={active}
                        aria-pressed={selected}
                        onClick={() => onToggleMcp?.(mcp)}
                        onMouseEnter={() => setActiveKey(navigationKey)}
                        className={`chat-command-menu-item chat-command-menu-mcp${active ? " is-active" : ""}${selected ? " is-selected" : ""}`}
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
