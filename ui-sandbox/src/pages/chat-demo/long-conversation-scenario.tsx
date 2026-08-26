import { MarkdownShowcase } from "./markdown-showcase";
import {
  AssistantMessage,
  SystemReminder,
  ThoughtBlock,
  ToolCallGroup,
  ToolRow,
  UserMessage,
} from "./message-primitives";
import { useDemoTranslation } from "./use-demo-copy";

const LONG_TOOL_CALL_COUNT = 104;
const LONG_TOOL_CALLS = Array.from({ length: LONG_TOOL_CALL_COUNT }, (_, index) => ({
  id: `mock-tool-${index + 1}`,
  index: index + 1,
}));

/** Stress scene: long Markdown plus more than one hundred independently rendered tool calls. */
export function LongConversationScenario() {
  const { t } = useDemoTranslation();
  return (
    <div className="chat-demo__long-thread">
      <div className="chat-demo__date-anchor">
        <span />
        {t("longConversation.day1")}
        <span />
      </div>
      <UserMessage promptAnchorId="long-prompt-design">{t("longConversation.longUser")}</UserMessage>
      <AssistantMessage>
        <MarkdownShowcase variant="long" />
      </AssistantMessage>
      <SystemReminder title={t("systemReminder.title")} />
      <div className="chat-demo__date-anchor">
        <span />
        {t("longConversation.day2")}
        <span />
      </div>
      <UserMessage promptAnchorId="long-prompt-tools">{t("longConversation.toolStressUser")}</UserMessage>
      <AssistantMessage compact copyable={false}>
        <ToolCallGroup
          count={LONG_TOOL_CALL_COUNT}
          complete={101}
          failed={2}
          running={1}
          thinking={
            <ThoughtBlock label="工具调用中的思考">
              正在根据前一批检查结果决定后续模块顺序；这个模型在工具调用期间有思考过程，但没有额外正文。
            </ThoughtBlock>
          }
        >
          {LONG_TOOL_CALLS.map((tool) => {
            const status =
              tool.index === LONG_TOOL_CALL_COUNT ? "running" : tool.index % 37 === 0 ? "failed" : "complete";
            return (
              <ToolRow
                key={tool.id}
                title={t("longConversation.batchToolTitle", { index: tool.index })}
                detail={t("longConversation.batchToolDetail", { index: tool.index })}
                status={status}
              />
            );
          })}
        </ToolCallGroup>
      </AssistantMessage>
      <div className="chat-demo__unread-anchor">
        <span>{t("longConversation.unread")}</span>
      </div>
      <UserMessage promptAnchorId="long-prompt-trace">{t("longConversation.finalUser")}</UserMessage>
      <AssistantMessage>
        <p>{t("longConversation.finalAssistant", { count: LONG_TOOL_CALL_COUNT })}</p>
      </AssistantMessage>
    </div>
  );
}
