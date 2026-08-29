import { ArrowUpRight, CircleAlert, CircleCheck, FileText, RotateCcw, Sparkles } from "lucide-react";
import { useState } from "react";
import { AssetShowcase } from "./asset-showcase";
import type { DemoScenarioId } from "./demo-model";
import { Button } from "./demo-ui";
import { LongConversationScenario } from "./long-conversation-scenario";
import { MarkdownShowcase } from "./markdown-showcase";
import {
  AssistantMessage,
  AttachmentPills,
  SystemReminder,
  ThoughtBlock,
  ToolRow,
  UserMessage,
} from "./message-primitives";
import { useDemoTranslation } from "./use-demo-copy";

export function ScenarioContent({ scenarioId }: { scenarioId: DemoScenarioId }) {
  switch (scenarioId) {
    case "conversation":
      return <ConversationScenario />;
    case "longConversation":
      return <LongConversationScenario />;
    case "markdown":
      return <MarkdownScenario />;
    case "tools":
      return <ToolsScenario />;
    case "permission":
      return <PermissionScenario />;
    case "askUser":
      return <AskUserScenario />;
    case "subtask":
      return <SubtaskScenario />;
    case "files":
      return <FilesScenario />;
    case "assets":
      return <AssetsScenario />;
    case "failure":
      return <FailureScenario />;
    case "empty":
      return <EmptyScenario />;
  }
}

function AssetsScenario() {
  return (
    <>
      <UserMessage attachments={<AttachmentPills names={["chat-layout-reference.png", "site-component-spec.md"]} />}>
        请为会话补齐 iframe、Site 自定义组件和图片的显示方式，并统一输入附件预览。
      </UserMessage>
      <AssistantMessage copyable={false}>
        <p className="chat-demo__assistant-lead">
          我把富内容分成可放大图片、受限 iframe 和可识别的 Site 组件；三者都保留来源与打开动作。
        </p>
        <AssetShowcase />
      </AssistantMessage>
    </>
  );
}

function AskUserScenario() {
  const { t } = useDemoTranslation();
  return (
    <>
      <UserMessage>{t("askUser.user")}</UserMessage>
      <AssistantMessage>
        <p className="chat-demo__assistant-lead">{t("askUser.assistant")}</p>
      </AssistantMessage>
    </>
  );
}

function ConversationScenario() {
  const { t } = useDemoTranslation();
  return (
    <>
      <UserMessage>{t("conversation.user")}</UserMessage>
      <SystemReminder title={t("systemReminder.title")} />
      <AssistantMessage>
        <ThoughtBlock label={t("conversation.thinkingLabel")}>{t("conversation.thinkingBody")}</ThoughtBlock>
        <div className="chat-demo__prose">
          <p>{t("conversation.assistantIntro")}</p>
          <ol>
            <li>{t("conversation.assistantPoint1")}</li>
            <li>{t("conversation.assistantPoint2")}</li>
            <li>{t("conversation.assistantPoint3")}</li>
          </ol>
          <p>{t("conversation.assistantOutro")}</p>
        </div>
      </AssistantMessage>
    </>
  );
}

function MarkdownScenario() {
  const { t } = useDemoTranslation();
  return (
    <>
      <UserMessage>{t("markdown.user")}</UserMessage>
      <AssistantMessage>
        <MarkdownShowcase />
      </AssistantMessage>
    </>
  );
}

function ToolsScenario() {
  const { t } = useDemoTranslation();
  return (
    <>
      <UserMessage>{t("tools.user")}</UserMessage>
      <AssistantMessage compact copyable={false}>
        <p className="chat-demo__assistant-lead">{t("tools.assistant")}</p>
        <div className="chat-demo__tool-group">
          <ToolRow title={t("tools.readTitle")} detail={t("tools.readDetail")} status="complete" />
          <ToolRow title={t("tools.searchTitle")} detail={t("tools.searchDetail")} status="complete" />
          <ToolRow title={t("tools.editTitle")} detail={t("tools.editDetail")} status="complete" />
          <ToolRow title={t("tools.buildTitle")} detail={t("tools.buildDetail")} status="running">
            <pre>{t("tools.output")}</pre>
          </ToolRow>
        </div>
        <p className="chat-demo__assistant-result">{t("tools.result")}</p>
      </AssistantMessage>
    </>
  );
}

function PermissionScenario() {
  const { t } = useDemoTranslation();
  return (
    <>
      <UserMessage>{t("permission.user")}</UserMessage>
      <AssistantMessage>
        <p className="chat-demo__assistant-lead">{t("permission.assistant")}</p>
      </AssistantMessage>
    </>
  );
}

function SubtaskScenario() {
  const { t } = useDemoTranslation();
  return (
    <>
      <UserMessage>{t("subtask.user")}</UserMessage>
      <AssistantMessage>
        <p className="chat-demo__assistant-lead">{t("subtask.assistant")}</p>
        <div className="chat-demo__summary">
          <Sparkles />
          {t("subtask.summary")}
        </div>
      </AssistantMessage>
    </>
  );
}

function FilesScenario() {
  const { t } = useDemoTranslation();
  return (
    <>
      <UserMessage attachments={<AttachmentPills names={[t("files.attachment1"), t("files.attachment2")]} />}>
        {t("files.user")}
      </UserMessage>
      <AssistantMessage>
        <div className="chat-demo__prose">
          <p>{t("files.assistant")}</p>
          <div className="chat-demo__citations">
            <button type="button">
              <FileText />
              {t("files.citation1")}
              <ArrowUpRight />
            </button>
            <button type="button">
              <FileText />
              {t("files.citation2")}
              <ArrowUpRight />
            </button>
          </div>
          <h3>{t("files.changeTitle")}</h3>
          <ul>
            <li>{t("files.change1")}</li>
            <li>{t("files.change2")}</li>
            <li>{t("files.change3")}</li>
          </ul>
        </div>
      </AssistantMessage>
    </>
  );
}

function FailureScenario() {
  const { t } = useDemoTranslation();
  const [reconnected, setReconnected] = useState(false);
  return (
    <>
      <UserMessage>{t("failure.user")}</UserMessage>
      <AssistantMessage compact>
        <p className="chat-demo__assistant-lead">{t("failure.assistant")}</p>
      </AssistantMessage>
      <div className="chat-demo__failure" role="alert" data-reconnected={reconnected}>
        <span>{reconnected ? <CircleCheck /> : <CircleAlert />}</span>
        <div>
          <strong>{reconnected ? t("status.ready") : t("failure.bannerTitle")}</strong>
          <p>{t("failure.bannerBody")}</p>
          <small>{t("failure.lastEvent")}</small>
          {!reconnected && <code>{t("failure.diagnostic")}</code>}
        </div>
        <Button variant="outline" size="sm" disabled={reconnected} onClick={() => setReconnected(true)}>
          <RotateCcw />
          {t("controls.retry")}
        </Button>
      </div>
    </>
  );
}

function EmptyScenario() {
  const { t } = useDemoTranslation();
  return (
    <div className="chat-demo__empty-state">
      <span className="chat-demo__empty-mark">
        <Sparkles />
      </span>
      <small>{t("empty.eyebrow")}</small>
      <h2>{t("empty.title")}</h2>
      <p>{t("empty.description")}</p>
      <div>
        {["suggestion1", "suggestion2", "suggestion3"].map((key) => (
          <button key={key} type="button">
            {t(`empty.${key}`)}
            <ArrowUpRight />
          </button>
        ))}
      </div>
    </div>
  );
}
