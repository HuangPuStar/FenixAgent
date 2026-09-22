import { useMockChatSession } from "@fenix/ui-components/chat/mocks/mock-chat-store";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";
import { ChatBubblesExamples } from "./internal/chat-demo-bubbles";
import { ChatCommandMenuExamples } from "./internal/chat-demo-command-menu";
import { ChatPanelsExamples } from "./internal/chat-demo-panels";
import { ChatTimelineExamples } from "./internal/chat-demo-timeline";

/**
 * Chat L3 分区：会话元件层 —— 气泡与消息部件、工具时间线、命令菜单、面板（权限 / 问答 / 状态）。
 *
 * 这一层是「会话里能被整体指认的部件」：它们已经认识会话的领域形状（ThreadEntry、权限请求、
 * 问答项、可用命令），但不自己取数 —— 数据由宿主（这里是示例）投喂。往上被 L2 的消息流与输入岛
 * 组装，往下由 L4 的消息基元拼装。
 *
 * 面板一组直接吃包内 `web/chat/mocks` 的 mock 会话：权限与问答应答经 `session.respondPermission` /
 * `respondQuestion` 回到 mock 状态机，待办与变更文件按 ChatInterface 的取数方式从时间线派生，
 * 因此本分区需要创建一份 mock 会话并传给面板（面板组件沿用「会话由调用方注入」的签名）。
 * 其余三组只用模块级静态数据，交互回调写到提示行。整个分区零网络、零 YJS、零路由。
 *
 * L2 与 L3 分属不同页面，不共享同一份 mock 会话（跨分区提升会话实例的收益不抵示例复杂度）。
 */

export function ChatL3Section() {
  const { t } = useTranslation(DEMO_NS);
  const session = useMockChatSession();

  return (
    <section>
      <h1 data-slot="demo-section-title" className="mb-6 text-[24px] font-semibold">
        {t("sections.chatL3")}
      </h1>
      <p className="mt-3 text-text-muted text-[12px]">{t("sectionHints.chatL3")}</p>

      <ChatBubblesExamples />
      <ChatTimelineExamples />
      <ChatCommandMenuExamples />
      <ChatPanelsExamples session={session} />
    </section>
  );
}
