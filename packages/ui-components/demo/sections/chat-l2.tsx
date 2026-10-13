import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";
import { ChatComposerExamples } from "./internal/chat-demo-composer";
import { ChatMessagesExamples } from "./internal/chat-demo-messages";
import { ChatSessionListExamples } from "./internal/chat-demo-sessions";

/**
 * Chat L2 分区：会话主区层 —— 会话列表、消息流与输入岛三块「整块区域」。
 *
 * 与上下层的分界：L1（外壳）按这个顺序把三者拼进 ACPMain；L3（元件）与 L4（基元）是它们内部
 * 用到的部件。因此本层只演示区域级构件自己的契约（列表的选中/改名/删除、消息流的滚动与引用、
 * 输入岛的附件与命令入口），不重复演示区域里的元件。
 *
 * 会话列表一组自持包内 `web/chat/mocks` 的 mock 会话，消息流与输入岛两组吃包内 mock 工厂
 * （`createMockChatEntries` / `MOCK_AVAILABLE_COMMANDS` 等）与模块级静态常量；
 * 所有交互回调把载荷打到示例下方的提示行。整个分区零网络、零 YJS、零路由。
 *
 * L1 与 L2 分属不同页面，不共享同一份 mock 会话：跨分区同步需要把会话实例提升到 demo 外壳，
 * 收益不抵示例复杂度（L1 的外壳示例已完整演示同一份会话在多处同步变化的现象）。
 */

export function ChatL2Section() {
  const { t } = useTranslation(DEMO_NS);

  return (
    <section>
      <h1 data-slot="demo-section-title" className="mb-6 text-[24px] font-semibold">
        {t("sections.chatL2")}
      </h1>
      <p className="mt-3 text-text-muted text-[12px]">{t("sectionHints.chatL2")}</p>

      <ChatSessionListExamples />
      <ChatMessagesExamples />
      <ChatComposerExamples />
    </section>
  );
}
