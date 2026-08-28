import { Bot, ChevronDown, Loader2 } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AssistantMessageEntry, ThreadEntry, ToolCallEntry } from "../../src/lib/types";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { ToolCallGroup } from "./ToolCallGroup";

// =============================================================================
// 子 Agent 执行轨迹 — 作为父级工具调用的可折叠详情，避免嵌套消息流造成视觉噪音
// =============================================================================

interface SubAgentPanelProps {
  entries: ThreadEntry[];
}

interface SubAgentSummary {
  messageCount: number;
  toolCount: number;
  isRunning: boolean;
}

/** 子 agent 内部消息渲染：保留执行输出与工具步骤，隐藏重复的委派用户消息。 */
function SubAgentTimeline({ entries }: { entries: ThreadEntry[] }) {
  const grouped = groupToolCalls(entries);

  return (
    <div className="relative space-y-3 border-l border-border/70 py-1 pl-4 before:absolute before:-left-[3px] before:top-0 before:h-1.5 before:w-1.5 before:rounded-full before:bg-brand">
      {grouped.map((item, index) => {
        if (item.type === "single") {
          if (item.entry.type !== "assistant_message") return null;
          return <SubAssistantText key={item.entry.id || `sub-message-${index}`} chunks={item.entry.chunks} />;
        }

        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: tool group entries lack unique key
          <div key={`sub-tool-group-${index}`} className="[&_.tool-call-group]:!pl-0">
            <ToolCallGroup entries={item.entries} />
          </div>
        );
      })}
    </div>
  );
}

/** 子 agent 的文本输出使用低对比度摘要卡，和工具步骤形成清晰层次。 */
function SubAssistantText({ chunks }: { chunks: AssistantMessageEntry["chunks"] }) {
  const text = chunks
    .filter(
      (chunk): chunk is Extract<AssistantMessageEntry["chunks"][number], { type: "message" }> =>
        chunk.type === "message",
    )
    .map((chunk) => chunk.text)
    .join("");

  if (!text) return null;

  return (
    <div className="rounded-md bg-surface-1/70 px-3 py-2 font-display text-xs leading-relaxed text-text-secondary whitespace-pre-wrap break-words">
      {text}
    </div>
  );
}

function summarizeEntries(entries: ThreadEntry[]): SubAgentSummary {
  return entries.reduce<SubAgentSummary>(
    (summary, entry) => {
      if (entry.type === "assistant_message") {
        summary.messageCount += 1;
      }
      if (entry.type === "tool_call") {
        summary.toolCount += 1;
        summary.isRunning ||=
          entry.toolCall.status === "running" || entry.toolCall.status === "waiting_for_confirmation";
      }
      return summary;
    },
    { messageCount: 0, toolCount: 0, isRunning: false },
  );
}

export const SubAgentPanel = memo(function SubAgentPanel({ entries }: SubAgentPanelProps) {
  const { t } = useTranslation("components");
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => summarizeEntries(entries), [entries]);

  if (entries.length === 0) return null;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="overflow-hidden rounded-lg border border-border/70 bg-surface-0 shadow-xs"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
            {summary.isRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium text-text-primary">{t("subAgentPanel.title")}</span>
            <span className="mt-0.5 block text-[11px] text-text-dim">
              {t("subAgentPanel.summary", { messages: summary.messageCount, tools: summary.toolCount })}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-text-dim transition-transform duration-200 group-data-[state=open]:rotate-180" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border/70 bg-surface-1/30 px-3 py-3">
          <SubAgentTimeline entries={entries} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

// =============================================================================
// 工具调用分组逻辑（与 ChatView 相同）
// =============================================================================

type GroupedItem = { type: "single"; entry: ThreadEntry } | { type: "tool_group"; entries: ToolCallEntry[] };

function groupToolCalls(entries: ThreadEntry[]): GroupedItem[] {
  const result: GroupedItem[] = [];
  let currentToolGroup: ToolCallEntry[] = [];

  const flushToolGroup = () => {
    if (currentToolGroup.length > 0) {
      result.push({ type: "tool_group", entries: currentToolGroup });
    }
    currentToolGroup = [];
  };

  for (const entry of entries) {
    if (entry.type === "tool_call") {
      currentToolGroup.push(entry);
    } else {
      flushToolGroup();
      result.push({ type: "single", entry });
    }
  }
  flushToolGroup();

  return result;
}
