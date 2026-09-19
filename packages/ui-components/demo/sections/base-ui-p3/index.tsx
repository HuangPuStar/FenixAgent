import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../../i18n";
import { ChatDescendedExamples } from "./chat-descended";
import { ControlsExamples } from "./controls";
import { DataDisplayExamples } from "./data-display";
import { FeedbackOverlayExamples } from "./feedback-overlay";
import { FormsExamples } from "./forms";

/**
 * Base UI P3 分区：基础控件。
 *
 * 本层是「最小可用的交互与展示单元」：按钮、表单控件、浮层与展示基元只表达自身状态
 * （受控 / 非受控、禁用、校验失败、加载占位），不承载业务契约 —— 数据从哪来、失败如何重试、
 * 流程如何编排都由更上层决定，因此这里的示例数据全部是文件内的静态常量或本地 state。
 *
 * 除基础控件外，本层也收编从 Chat 下沉的通用展示件：对话气泡（Conversation / Message / MessageResponse）、
 * MessageAttachments、CodeBlock、Shimmer 与 IframePreview 原先挂在 Chat L4（消息基元）下，但它们
 * 不带消息 / 会话 / 工具 / 推理语义，与基础控件同属「任何页面都能直接用」的最小单元，
 * 故落到本分区（见 chat-descended.tsx）。
 *
 * 内容按子主题拆在同目录下，本文件只负责分区标题与组装顺序：
 * controls（交互控件）→ forms（表单控件）→ data-display（数据展示）→ feedback-overlay（弹窗与浮层）
 * → chat-descended（从 Chat 下沉的通用件）。
 */

export function BaseUiP3Section() {
  const { t } = useTranslation(DEMO_NS);

  return (
    <section className="demo-section">
      <h1 className="demo-section-title">{t("sections.baseUiP3")}</h1>
      <p className="demo-hint">{t("sectionHints.baseUiP3")}</p>

      <ControlsExamples />
      <FormsExamples />
      <DataDisplayExamples />
      <FeedbackOverlayExamples />
      <ChatDescendedExamples />
    </section>
  );
}
