/**
 * 活动链（思考 + 相邻工具调用）的折叠容器。
 *
 * 交互口径：运行中默认展开，整条链结束后自动折叠；用户手动切换后以手动状态为准，不再被自动折叠覆盖。
 * 折叠只影响渲染（收起时不挂载工具行），标题由纯函数 `summarizeActivityChain` 投影。
 *
 * 动效克制：只有 chevron 的旋转，且 `motion-reduce` 下关闭；折叠体可滚动并限制高度，
 * 避免长命令输出把整条时间线顶开。
 */

import type { LucideIcon } from "lucide-react";
import {
  Brain,
  ChevronRight,
  FilePen,
  FileText,
  Globe,
  HelpCircle,
  ListTodo,
  Search,
  Sparkles,
  Terminal,
  Workflow,
  Wrench,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { cn } from "../../lib/cn";
import type { ActivityCategory } from "../lib/activity-chain-summary";
import { isActivityChainActive, summarizeActivityChain } from "../lib/activity-chain-summary";
import type { ChatRenderItem } from "../lib/chat-render-layout";
import { SubAgentToolCallGroupContext } from "../timeline/sub-agent-tool-call-context";
import { ToolCallGroup } from "../timeline/ToolCallGroup";
import type { ThreadEntry, ToolCallEntry } from "../types";
import { ChatRenderItemView, renderItemKey } from "./chat-render-item-view";
import type { CardEmitter } from "./internal/card-emitter";

const CATEGORY_ICONS: Record<ActivityCategory, LucideIcon> = {
  read: FileText,
  search: Search,
  edit: FilePen,
  command: Terminal,
  web: Globe,
  subagent: Workflow,
  todo: ListTodo,
  skill: Sparkles,
  question: HelpCircle,
  tool: Wrench,
};

/** 标题最多展示的类别数；其余合并为「+N 类」，避免长链标题溢出。 */
const MAX_VISIBLE_CATEGORIES = 3;

/** 活动链作用域内的子 Agent 工具组渲染器：与链内其它工具行一致地带上对齐补偿。 */
function renderChainToolGroup(entries: ToolCallEntry[]) {
  return <ToolCallGroup entries={entries} inActivityChain />;
}

export interface ActivityChainProps {
  items: ChatRenderItem[];
  /** 整条时间线是否仍在加载（用于判断末尾思考是否仍在产出）。 */
  isLoading: boolean;
  /** 当前会话末条条目；只有它会被当作流式内容。 */
  lastEntry?: ThreadEntry;
  /**
   * 链前是否紧邻助手正文。
   *
   * 仅作为 `data-after-message` 钩子保留：折叠标题让活动链从「正文的延续」变成独立过程块，
   * 上下间距统一为 `my-2`，不再用负上边距贴住正文。
   */
  afterMessage: boolean;
  sessionId?: string;
  envId?: string;
  cardEmitter?: CardEmitter;
  onQuote?: (text: string, sessionId?: string) => void;
  onOpenWorkspaceFile?: (envId: string, path: string) => void;
}

/** 活动链：折叠标题 + 可收起的逐项内容。 */
export function ActivityChain({
  items,
  isLoading,
  lastEntry,
  afterMessage,
  sessionId,
  envId,
  cardEmitter,
  onQuote,
  onOpenWorkspaceFile,
}: ActivityChainProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const bodyId = useId();
  const summary = useMemo(() => summarizeActivityChain(items), [items]);
  const active = isActivityChainActive(items, isLoading);
  // `null` 表示尚未手动干预：展开状态完全跟随运行态，链结束后自动折叠。
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const expanded = manualExpanded ?? active;

  const visibleCategories = summary.categories.slice(0, MAX_VISIBLE_CATEGORIES);
  const hiddenCategoryCount = summary.categories.length - visibleCategories.length;
  const toggleLabel = expanded
    ? t("chat.components.activityChain.collapse")
    : t("chat.components.activityChain.expand");

  return (
    <div
      // 本行工具类即源 `chat-design-messages.css` 的 `.chat-activity-chain` 声明；
      // 标题与正文左缘对齐，轨道缩进只作用于展开后的链内条目（见下方 rail 包裹层）。
      // 上下对称的 `my-2` 与相邻条目各自的 `py-3` 组成一致的过程块间距。
      className="grid gap-px mx-0 my-2"
      data-slot="chat-activity-chain"
      data-after-message={afterMessage || undefined}
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 pr-1 text-left text-xs text-slate-400 hover:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
        data-slot="chat-activity-chain-toggle"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        title={t("chat.components.activityChain.steps", { count: summary.toolCount })}
        onClick={() => setManualExpanded(!expanded)}
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 transition-transform motion-reduce:transition-none", expanded && "rotate-90")}
          aria-hidden
        />
        {summary.hasThought && (
          <span className="inline-flex shrink-0 items-center" title={t("chat.components.activityChain.thinking")}>
            <Brain className="h-3 w-3" aria-hidden />
            <span className="sr-only">{t("chat.components.activityChain.thinking")}</span>
          </span>
        )}
        {visibleCategories.map(({ category, count }) => {
          const Icon = CATEGORY_ICONS[category];
          const label = t(`chat.components.activityChain.category.${category}`);
          return (
            <span key={category} className="inline-flex shrink-0 items-center gap-0.5">
              <Icon className="h-3 w-3" aria-hidden />
              <span className="tabular-nums">
                {label} {count}
              </span>
            </span>
          );
        })}
        {hiddenCategoryCount > 0 && (
          <span className="shrink-0 tabular-nums">
            +{hiddenCategoryCount}
            <span className="sr-only">
              {" "}
              {t("chat.components.activityChain.moreCategories", { count: hiddenCategoryCount })}
            </span>
          </span>
        )}
        {summary.errorCount > 0 && (
          <span className="shrink-0 text-red-400">
            {t("chat.components.activityChain.failed", { count: summary.errorCount })}
          </span>
        )}
        {active && <span className="shrink-0 text-slate-400">{t("chat.components.activityChain.running")}</span>}
        <span className="sr-only">{toggleLabel}</span>
      </button>

      {expanded && (
        // 轨道线挂在滚动容器外层，避免随内容滚动。折叠体是滚动容器，会裁剪越界内容：
        // 链内工具行用 `-ml-8` 把图标放回轨道槽，故用 `pl-8` 让裁剪框覆盖槽位，否则图标会被裁掉。
        <div
          className="relative before:absolute before:top-0 before:bottom-2.75 before:left-2.75 before:w-px before:bg-slate-200 before:content-['']"
          data-slot="chat-activity-chain-rail"
        >
          <div id={bodyId} className="grid max-h-100 gap-px overflow-y-auto pl-8" data-slot="chat-activity-chain-body">
            {/* 链内的子 Agent 面板若再渲染工具组，同样属于「链内」——用作用域化的渲染器覆盖
                Context（源的后代选择器对嵌套工具组一视同仁）。 */}
            <SubAgentToolCallGroupContext.Provider value={renderChainToolGroup}>
              {items.map((item, itemIndex) => (
                <ChatRenderItemView
                  key={renderItemKey(item, itemIndex)}
                  item={item}
                  inActivityChain
                  isLoading={isLoading && item.type === "entry" && item.entry === lastEntry}
                  sessionId={sessionId}
                  envId={envId}
                  cardEmitter={cardEmitter}
                  onQuote={onQuote}
                  onOpenWorkspaceFile={onOpenWorkspaceFile}
                />
              ))}
            </SubAgentToolCallGroupContext.Provider>
          </div>
        </div>
      )}
    </div>
  );
}
