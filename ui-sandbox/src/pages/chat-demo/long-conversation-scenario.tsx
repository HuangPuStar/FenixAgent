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
        <div className="chat-demo__activity-chain">
          <ThoughtBlock label="思考了一会">先确认用户目录与备忘录目录，再读取项目配置。</ThoughtBlock>
          <ToolRow title="执行 $ ls -la user/" detail="检查用户文件目录" status="complete" />
          <ThoughtBlock label="思考了一会">目录存在，继续检查备忘录内容和依赖配置。</ThoughtBlock>
          <ToolRow
            title={
              '执行 $ bun -e "const entry = /Users/konghayao/code/pazhou/remote-control-server/workspaces/very-long-path/index.ts"'
            }
            detail="检查超长命令的截断与状态保留"
            status="complete"
          />
          <ThoughtBlock label="思考了一会">结构已确认，读取 package.json 获取脚本与依赖。</ThoughtBlock>
          <ToolRow title="读取 package.json" detail="读取项目配置" status="complete" />
          <ThoughtBlock label="思考了一会">工具结果已经齐全，准备组织最终回复。</ThoughtBlock>
        </div>
      </AssistantMessage>
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
