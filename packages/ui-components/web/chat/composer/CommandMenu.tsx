import "./CommandMenu.css";

import { CheckCircle2, Plug, Search, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { cn } from "../../lib/cn";
import { Input } from "../../ui/input";
import { ScrollArea } from "../../ui/scroll-area";
import { useRovingListNavigation } from "../../ui/use-roving-list-navigation";
import type { AvailableCommand } from "../types";

/**
 * Slash 命令 / 技能 / MCP 选择菜单。
 *
 * 来源：复制自 `packages/agent-runtime/web/components/chat/CommandMenu.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 * 纯化改动点：`@fenix/chat-channel` 的 `AvailableCommand` → 包内 `../types`；
 * `@/components/ui/{input,scroll-area,use-roving-list-navigation}` → 包内 `../../ui/*`；
 * 命名空间改为 `UI_COMPONENTS_NS`（键 `chat.components.commandMenu.*`）；
 * 结构、键盘导航与类名逐字保留。
 *
 * 纯化改动（2026-09-18，命令/技能行改版）：
 * 1. 行首的 `/` 前缀文字改为图标：这些行在能力面板里就是「技能」（区间标题即 `Skills`），
 *    故用技能目录页的代表图标 `Sparkles`（见 `packages/resources/skill/web/pages/agent-panel/pages/agent-skills-catalog.tsx`
 *    的 `getSkillIcon` 兜底分支），与 MCP 行的 `Plug` 同构（MCP 行一直是「图标 + 名称」）。
 * 2. 图标独立占网格首列（源里只有 MCP 行有图标列），技能行与 MCP 行的名称因此左对齐；
 *    名称不再带 `/{name}`，插入草稿的文本仍由 `ChatComposer` 拼 `/${name} `，协议不变。
 * 3. 右侧提示与选中勾选收进尾列容器：二者同属行的尾列，源实现把它们与
 *    名称/描述并列为网格子项，一行同时有提示与勾选时会多出一个子项被挤到隐式第二行。
 *
 * 样式迁移（2026-09-22）：原 `../css/chat-design-command-menu.css` 中由本组件渲染的选择器
 * 已逐条改写为下方 `className` 的 Tailwind 工具类，数值/色值逐字保持。要点：
 * - 三形态差异：基础形态（popover/inline 共用的基类）的声明写在 `<div>` 的基类里；
 *   「能力面板」形态（`variant="panel"`）在基类之后追加覆盖，两者靠 `cn()`（tailwind-merge）
 *   的「后者胜出」消解同族冲突，等价于源实现的 `.chat-command-menu--panel` 特指度覆盖。
 *   未渲染的 popover/inline 外壳（容器、头部、标题、计数、底部快捷键条）无挂载点，阶段五已随
 *   `../css/chat-design-command-menu.css` 整文件删除（团队确认该形态退役）。
 *   **若将来要渲染这些外壳**：按现行约定把声明写进**该渲染点**的 `className`（Tailwind 工具类），
 *   不要恢复那份样式表，也不要重新引入 `.chat-command-*` 语义类名。
 * - `is-active` 状态改为条件类组合，`is-selected` 在原样式表中没有任何声明（纯语义钩子）故直接删除；
 *   两者原有的状态语义由既有的 `data-active` 与 `aria-pressed` 承担。
 *
 * 样式下沉（2026-09-22，禁令 FCP-WEB-02）：网格列定义、投影与 `min/max` 复合值改由同目录
 * `CommandMenu.css` 承载——容器投影（`.chat-command-surface`）、行网格（`.chat-command-row`）、
 * 搜索行图标基准（`.chat-command-search-icon`）、滚动区高度（`.chat-command-scroll`）。
 * 面板形态的覆盖改为「根节点挂 `--panel` 修饰类、样式表里按源顺序覆盖基类」，
 * 与原 `cn()`（tailwind-merge）的「后者胜出」等价，扁平工具类仍留在 `className`。
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
  /**
   * 形态选择（可选，默认基础形态）：`"panel"` 为输入岛能力面板，按源 `.chat-command-menu--panel`
   * 的密度覆盖基础形态（高度/内边距/网格列/shadow）；基础形态即 popover/inline 共用的基类外观。
   */
  variant?: "default" | "panel";
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
 * 当前行（键盘导航或鼠标悬停命中）的强调样式。
 *
 * 基础形态：中性底色 + 左侧主题色强调条（源 `box-shadow: inset 2px 0 var(--color-brand)`）；
 * 面板形态：只有底色，无强调条（源 `box-shadow: none`）。
 */
function activeClassName(panel: boolean): string {
  return panel ? "bg-slate-50 text-slate-800" : "bg-slate-100 text-slate-800 shadow-[inset_2px_0_var(--color-brand)]";
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
  variant = "default",
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
  const panel = variant === "panel";
  // 行/分区/文字的类名按 `variant` 组合：panel 形态的覆盖声明排在基础形态之后，由 cn()（tailwind-merge）
  // 消解同族冲突，等价于源实现「`.chat-command-menu--panel` 特指度覆盖基础类名」的级联结果。
  // active（键盘/悬停命中）的强调样式按行追加，见下方 `cn(itemClass, active && …)`。
  const itemClass = cn(
    "grid w-full items-center text-left text-gray-500 [transition:background_100ms_ease,color_100ms_ease]",
    "min-h-10.5 chat-command-row gap-2.5 rounded-md px-2.25 py-1.5",
    "hover:bg-slate-100 hover:text-slate-800",
    panel && "min-h-8.5 chat-command-row--panel gap-1.5 rounded-sm px-2 py-0.5",
    panel && "hover:bg-slate-50",
  );
  const nameClass = "overflow-hidden text-ellipsis whitespace-nowrap text-xs font-normal text-slate-800";
  const descriptionClass = "overflow-hidden text-ellipsis whitespace-nowrap text-3xs leading-normal text-gray-400";
  const iconClass = "h-4 w-4 flex-none text-gray-400";

  return (
    <div
      ref={containerRef}
      className={cn(
        "chat-command-surface overflow-hidden rounded-lg border border-gray-200 bg-white text-slate-800",
        panel && "chat-command-surface--panel mb-1.5 w-full",
        className,
      )}
    >
      {showSearch && (
        <div
          className={cn(
            "mx-2 mt-1.75 mb-0.75 flex h-11.5 items-center gap-2 rounded-md bg-slate-50 px-2.5",
            panel && "m-0 h-9.5 rounded-none border-b border-gray-100 bg-white px-3",
          )}
        >
          <Search
            className={cn(
              "h-3.75 w-3.75 chat-command-search-icon text-gray-400",
              panel && "h-4 w-4 chat-command-search-icon--panel",
            )}
          />
          <Input
            type="text"
            placeholder={t("chat.components.commandMenu.searchPlaceholder")}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className={cn(
              "h-9 flex-1 border-0 bg-transparent p-0 text-xs text-slate-700 shadow-none focus-visible:ring-0",
              panel && "h-9.5",
            )}
            autoFocus
          />
        </div>
      )}
      <ScrollArea className={cn("chat-command-scroll", panel && "chat-command-scroll--panel")}>
        <div className={cn("px-2 pt-1 pb-1.75", panel && "px-2 py-0.5")}>
          {empty ? (
            <div className="px-4.5 py-8.5 text-center text-xs text-gray-400">
              {t("chat.components.commandMenu.noMatch")}
            </div>
          ) : (
            <>
              {filteredCommands.length > 0 && (
                <section>
                  {showSearch && (
                    <div className="flex items-baseline gap-1.5 px-2 pt-0.75 pb-1">
                      <strong className="text-xs font-[650] text-slate-800">
                        {t("chat.components.commandMenu.skills")}
                      </strong>
                      <span className="text-3xs text-gray-400">{t("chat.components.commandMenu.skillsCaption")}</span>
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
                        className={cn(itemClass, active && activeClassName(panel))}
                      >
                        <Sparkles className={iconClass} />
                        <span className={nameClass}>{command.name}</span>
                        <span className={descriptionClass}>{command.description}</span>
                        {(hint || selected) && (
                          <span className="flex items-center justify-self-end gap-2">
                            {hint && (
                              <span className={cn("text-3xs not-italic text-gray-400", panel && "text-3xs")}>
                                {hint}
                              </span>
                            )}
                            {selected && <CheckCircle2 className="h-4 w-4 flex-none text-teal-700" />}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </section>
              )}
              {showSearch && filteredMcps.length > 0 && (
                <section
                  className={
                    // 源 `.chat-command-menu-section + .chat-command-menu-section`：仅当 MCP 分区前面
                    // 还有技能分区（相邻兄弟）时才加分隔线与间距。
                    filteredCommands.length > 0 ? "mt-0.75 border-t border-gray-100 pt-0.75" : undefined
                  }
                >
                  <div className="flex items-baseline gap-1.5 px-2 pt-0.75 pb-1">
                    <strong className="text-xs font-[650] text-slate-800">
                      {t("chat.components.commandMenu.mcps")}
                    </strong>
                    <span className="text-3xs text-gray-400">{t("chat.components.commandMenu.mcpsCaption")}</span>
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
                        className={cn(itemClass, panel && "chat-command-row--mcp", active && activeClassName(panel))}
                      >
                        <Plug className={iconClass} />
                        <span className={nameClass}>{mcp.name}</span>
                        <span className={descriptionClass}>{mcp.description}</span>
                        <em className="ml-auto text-3xs not-italic text-teal-700">
                          {t("chat.components.commandMenu.connected")}
                        </em>
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
