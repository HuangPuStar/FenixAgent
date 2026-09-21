import { CheckCircle2, Plug, Search, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { Input } from "../../ui/input";
import { ScrollArea } from "../../ui/scroll-area";
import { useRovingListNavigation } from "../../ui/use-roving-list-navigation";
import type { AvailableCommand } from "../types";

/**
 * Slash 命令 / 技能 / MCP 选择菜单。
 *
 * 来源：复制自 `packages/agent-runtime/web/components/chat/CommandMenu.tsx`。
 * 纯化改动点：`@fenix/chat-channel` 的 `AvailableCommand` → 包内 `../types`；
 * `@/components/ui/{input,scroll-area,use-roving-list-navigation}` → 包内 `../../ui/*`；
 * 命名空间改为 `UI_COMPONENTS_NS`（键 `chat.components.commandMenu.*`）；
 * 结构、键盘导航与类名逐字保留。
 *
 * 纯化改动（2026-09-18，命令/技能行改版，样式见 `../css/chat-design-command-menu.css`）：
 * 1. 行首的 `/` 前缀文字改为图标：这些行在能力面板里就是「技能」（区间标题即 `Skills`），
 *    故用技能目录页的代表图标 `Sparkles`（见 `packages/resources/skill/.../agent-skills-catalog.tsx`
 *    的 `getSkillIcon` 兜底分支），与 MCP 行的 `Plug` 同构（MCP 行一直是「图标 + 名称」）。
 * 2. 图标独立占网格首列（源里只有 MCP 行有图标列），技能行与 MCP 行的名称因此左对齐；
 *    名称不再带 `/{name}`，插入草稿的文本仍由 `ChatComposer` 拼 `/${name} `，协议不变。
 * 3. 右侧提示与选中勾选收进 `.chat-command-menu-tail`：二者同属行的尾列，源实现把它们与
 *    名称/描述并列为网格子项，一行同时有提示与勾选时会多出一个子项被挤到隐式第二行。
 */

/** Agent 已绑定的 MCP 连接（本轮上下文候选）。 */
export interface McpOption {
  id: string;
  name: string;
  description: string;
}

interface CommandMenuProps {
  commands: readonly AvailableCommand[];
  mcps?: readonly McpOption[];
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

/** 按名称或描述匹配命令（源实现逐字保留）。 */
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
  const { t } = useTranslation(UI_COMPONENTS_NS);
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
            placeholder={t("chat.components.commandMenu.searchPlaceholder")}
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
            <div className="chat-command-menu-empty">{t("chat.components.commandMenu.noMatch")}</div>
          ) : (
            <>
              {filteredCommands.length > 0 && (
                <section className="chat-command-menu-section">
                  {showSearch && (
                    <div className="chat-command-menu-section-title">
                      <strong>{t("chat.components.commandMenu.skills")}</strong>
                      <span>{t("chat.components.commandMenu.skillsCaption")}</span>
                    </div>
                  )}
                  {filteredCommands.map((command) => {
                    const navigationKey = `skill:${command.name}`;
                    const active = navigationKey === activeKey;
                    const selected = selectedCommandNames.has(command.name);
                    const hint = command.input?.hint;
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
                        <Sparkles className="chat-command-menu-command-icon" />
                        <span className="chat-command-menu-name">{command.name}</span>
                        <span className="chat-command-menu-description">{command.description}</span>
                        {(hint || selected) && (
                          <span className="chat-command-menu-tail">
                            {hint && <span className="chat-command-menu-hint">{hint}</span>}
                            {selected && <CheckCircle2 className="chat-command-menu-check" />}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </section>
              )}
              {showSearch && filteredMcps.length > 0 && (
                <section className="chat-command-menu-section">
                  <div className="chat-command-menu-section-title">
                    <strong>{t("chat.components.commandMenu.mcps")}</strong>
                    <span>{t("chat.components.commandMenu.mcpsCaption")}</span>
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
                        <em className="chat-command-menu-mcp-state">{t("chat.components.commandMenu.connected")}</em>
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
