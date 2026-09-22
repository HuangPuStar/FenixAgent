import { useMockChatSession } from "@fenix/ui-components/chat/mocks/mock-chat-store";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";
import { ChatShellExamples } from "./internal/chat-demo-shell";

/**
 * Chat L1 分区：会话外壳层 —— 整个会话界面的骨架（ACPMain：侧栏 + 会话头 + 消息流 + 输入岛）。
 *
 * L1 是 Chat 体系里唯一「组装别人」的一层：ACPMain 内部依次用到会话列表与消息流、输入岛（L2）、
 * 工具时间线与面板（L3）、消息基元（L4），因此示例本身不含任何 Chat 元件，只演示外壳如何接线。
 *
 * 交互由包内 `web/chat/mocks` 的 `useMockChatSession()` 驱动：发送、取消、权限/问答应答、
 * 模式切换、新建与切换会话全部回到 mock 状态机；整个分区零网络、零 YJS、零路由。
 *
 * 本分区只渲染 ChatShellExamples 一组。L1 与 L2 分属不同页面，不共享同一份 mock 会话：
 * 跨分区同步需要把会话实例提升到 demo 外壳，收益不抵示例复杂度（本层外壳已完整演示
 * 「应答后多处同步变化」这一现象）。
 */

export function ChatL1Section() {
  const { t } = useTranslation(DEMO_NS);
  const session = useMockChatSession();

  return (
    <section>
      <h1 data-slot="demo-section-title" className="mb-6 text-[24px] font-semibold">
        {t("sections.chatL1")}
      </h1>
      <p className="mt-3 text-text-muted text-[12px]">{t("sectionHints.chatL1")}</p>

      <ChatShellExamples session={session} />
    </section>
  );
}
