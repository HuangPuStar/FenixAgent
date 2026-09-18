import { useMockChatSession } from "@fenix/ui-components/chat/mocks/mock-chat-store";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";
import { ChatComposerExamples } from "./internal/chat-demo-composer";
import { ChatMessagesExamples } from "./internal/chat-demo-messages";
import { ChatPanelsExamples } from "./internal/chat-demo-panels";
import { ChatShellExamples } from "./internal/chat-demo-shell";
import { ChatTimelineExamples } from "./internal/chat-demo-timeline";

/**
 * Chat 体系分区：消息视图 / 工具时间线 / 输入岛 / 面板 / 会话外壳五组示例。
 *
 * 导出名被 demo/App.tsx 引用，新增示例时保持导出名与签名不变。
 *
 * 交互由包内 `web/chat/mocks` 的 `useMockChatSession()` 驱动：在输入岛回车会回放一段流式脚本
 * （推理 → 工具 → 计划 → 权限 → 问答 → 完成），权限与问答卡片可在暂停点直接应答；
 * 底部「重置 mock 会话」按钮把内存快照恢复为初始样本。整个分区零网络、零 YJS、零路由。
 *
 * 示例分组各自独立成文件（messages / timeline / composer / panels / shell），仅「面板」与「外壳」
 * 共享同一份 mock 会话，以便观察到应答后多处同步变化。
 */
export function ChatSection() {
  const { t } = useTranslation(DEMO_NS);
  const session = useMockChatSession();

  return (
    <section className="demo-section">
      <h1 className="demo-section-title">{t("sections.chat")}</h1>

      <ChatMessagesExamples />
      <ChatTimelineExamples session={session} />
      <ChatComposerExamples />
      <ChatPanelsExamples session={session} />
      <ChatShellExamples session={session} />
    </section>
  );
}
