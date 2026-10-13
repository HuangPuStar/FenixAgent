/**
 * chat 分区示例：消息流层（ChatView 的完整时间线 + 工具轨 + 活动链）。
 *
 * 数据来自包内 mocks 的 `createMockChatEntries()`：单条消息、气泡与工具卡片等下游部件
 * 由 L3/L4 的示例单独演示，这里只演示 ChatView 把它们按时间线串起来的样子，以及宿主需要注入的
 * 三个回调 —— 引用、打开工作区文件、采纳建议提示词；回调结果写到示例下方的提示行。
 */

import { ChatView } from "@fenix/ui-components";
import { createMockChatEntries } from "@fenix/ui-components/chat/mocks/mock-fixtures";
import { useState } from "react";

/** 主会话渲染条目：用户（含引用与系统提醒）、助手、工具、计划等全部形态。 */
const MOCK_ENTRIES = createMockChatEntries();

/** 消息流示例组。 */
export function ChatMessagesExamples() {
  const [lastAction, setLastAction] = useState<string | null>(null);

  return (
    <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
      <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
        ChatView（完整时间线 + 工具轨 + 活动链）
      </h2>
      {/* ChatView 内部的滚动区高度为 100%，外层必须给出确定高度并作为 flex 容器。 */}
      <div className="flex h-[520px] flex-col overflow-hidden rounded-lg border border-border">
        <ChatView
          entries={MOCK_ENTRIES}
          agentName="Fenix Agent"
          agentDescription="Chat UI 体系演示 Agent"
          envId="demo-env"
          onQuote={(text) => setLastAction(`引用：${text.slice(0, 32)}…`)}
          onOpenWorkspaceFile={(envId, path) => setLastAction(`打开工作区文件：${envId}/${path}`)}
          onApplySuggestedPrompt={(prompt) => setLastAction(`建议提示词：${prompt}`)}
        />
      </div>
      <p className="mt-3 text-text-muted text-[12px]">
        {lastAction ?? "点击消息上的「引用」或正文里的文件链接，回调会显示在这里。"}
      </p>
    </div>
  );
}
