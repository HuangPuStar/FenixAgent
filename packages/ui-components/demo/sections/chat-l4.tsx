import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";
import { ChatPrimitivesExamples } from "./internal/chat-demo-primitives";

/**
 * Chat L4 分区：消息基元层 —— 输入基元、推理与工具调用。
 *
 * 这一层是 Chat 体系里必须认识会话交互形状的最小复用单元（对应包内 `web/chat/primitives`，即源
 * `web/ai-elements` 组改名后的形态）：提示词输入、推理块与工具调用审批，由 L3 的元件（气泡、面板）
 * 与 L2 的主区把它们组装成完整界面。同一组里不带会话语义的展示件（Conversation / Message /
 * MessageResponse / MessageAttachments）已下沉到 Base UI P3，见 `sections/base-ui-p3/chat-descended.tsx`。
 *
 * 示例数据全部是模块级静态假数据，交互回调只写日志或提示行，用于验证回调确实触发；
 * 整个分区零网络、零 YJS、零路由。
 */

export function ChatL4Section() {
  const { t } = useTranslation(DEMO_NS);

  return (
    <section>
      <h1 data-slot="demo-section-title" className="mb-6 text-[24px] font-semibold">
        {t("sections.chatL4")}
      </h1>
      <p className="mt-3 text-text-muted text-[12px]">{t("sectionHints.chatL4")}</p>

      <ChatPrimitivesExamples />
    </section>
  );
}
