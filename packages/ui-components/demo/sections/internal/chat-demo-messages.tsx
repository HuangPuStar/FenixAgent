/**
 * chat 分区示例：消息视图层（ChatView 完整时间线 / 两类气泡 / 系统消息 / 引用 / 引用链接）。
 *
 * 数据来自包内 mocks 的 `createMockChatEntries()`（首条用户消息带聊天引用与两条 system-reminder）；
 * 系统提醒与引用的提取直接复用包内纯函数（`splitSystemReminderBlocks` / `parseChatQuotes`），
 * 交互回调只把结果写到示例下方的提示行，用于验证纯化后的回调确实被触发。
 */

import {
  AssistantBubble,
  type AssistantMessageEntry,
  ChatQuoteMessage,
  ChatView,
  CitationLink,
  parseChatQuotes,
  SystemMessage,
  splitSystemReminderBlocks,
  UserBubble,
  type UserMessageEntry,
} from "@fenix/ui-components";
import { createMockChatEntries } from "@fenix/ui-components/chat/mocks/mock-fixtures";
import { useState } from "react";

/** 主会话渲染条目：用户（含引用与系统提醒）、助手、工具、计划等全部形态。 */
const MOCK_ENTRIES = createMockChatEntries();

/** 单独渲染 UserBubble 的用户消息（带聊天引用与注入的 system-reminder）。 */
const MOCK_USER_ENTRY = MOCK_ENTRIES.find((entry): entry is UserMessageEntry => entry.type === "user_message");

/** 单独渲染 AssistantBubble 的助手消息（取带推理块的一条）。 */
const MOCK_ASSISTANT_ENTRY = MOCK_ENTRIES.find(
  (entry): entry is AssistantMessageEntry =>
    entry.type === "assistant_message" && entry.chunks.some((chunk) => chunk.type === "thought"),
);

/** 从用户消息正文里取一条 system-reminder 原文（渲染 SystemMessage 用）。 */
const MOCK_SYSTEM_REMINDER =
  splitSystemReminderBlocks(MOCK_USER_ENTRY?.content ?? "").find((segment) => segment.kind === "system")?.text ?? "";

/** 同一段 system-reminder 里解析出的聊天引用（引用胶囊的展示数据）。 */
const MOCK_QUOTES = parseChatQuotes(MOCK_SYSTEM_REMINDER);

/**
 * 引用胶囊的渲染数据：在模块级一次性绑定稳定 key。
 * 引用文本可能重复（quote 只保证 text + omittedCharacterCount），故不能用正文做 key；
 * 该列表是静态 mock，位置即身份，避免在 JSX 里直接以下标作 React key。
 */
const MOCK_QUOTE_ITEMS = MOCK_QUOTES.map((quote, index) => ({ id: `mock-quote-${index}`, quote, index }));

/** 消息视图示例组。 */
export function ChatMessagesExamples() {
  const [lastAction, setLastAction] = useState<string | null>(null);

  return (
    <>
      <div className="demo-example">
        <h2 className="demo-example-title">ChatView（完整时间线 + 工具轨 + 活动链）</h2>
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
        <p className="demo-hint">{lastAction ?? "点击消息上的「引用」或正文里的文件链接，回调会显示在这里。"}</p>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">UserBubble / AssistantBubble</h2>
        <div className="flex flex-col gap-6">
          {MOCK_USER_ENTRY ? (
            <UserBubble
              entry={MOCK_USER_ENTRY}
              envId="demo-env"
              onOpenWorkspaceFile={(envId, path) => setLastAction(`${envId}/${path}`)}
            />
          ) : null}
          {MOCK_ASSISTANT_ENTRY ? (
            <AssistantBubble
              entry={MOCK_ASSISTANT_ENTRY}
              onQuote={(text) => setLastAction(`引用：${text.slice(0, 32)}…`)}
            />
          ) : null}
        </div>
        <p className="demo-hint">首条用户消息自带引用胶囊与系统消息胶囊（注入上下文不进入可见正文）。</p>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">SystemMessage（双击查看原始内容）</h2>
        <SystemMessage rawText={MOCK_SYSTEM_REMINDER} />
        <p className="demo-hint">双击上方胶囊打开详情弹窗，查看完整的 system-reminder 原文。</p>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">ChatQuoteMessage / CitationLink</h2>
        <div className="chat-quote-messages">
          {MOCK_QUOTE_ITEMS.map((item) => (
            <ChatQuoteMessage key={item.id} quote={item.quote} index={item.index} />
          ))}
          <ChatQuoteMessage
            quote={{ text: "引用超过上限时按 code point 截断。", omittedCharacterCount: 512 }}
            index={1}
          />
        </div>
        <p className="mt-4 leading-relaxed">
          正文中的知识库引用形如{" "}
          <CitationLink
            resourceId="demo-resource-1"
            kbId="demo-kb-1"
            onOpen={(resourceId, kbId) => setLastAction(`打开引用：${kbId}/${resourceId}`)}
          >
            产品接入说明
          </CitationLink>
          ，点击回调由宿主注入（源实现走宿主的 CitationPreviewContext）。
        </p>
        <p className="demo-hint">{lastAction ?? "点击引用链接可看到回调结果。"}</p>
      </div>
    </>
  );
}
