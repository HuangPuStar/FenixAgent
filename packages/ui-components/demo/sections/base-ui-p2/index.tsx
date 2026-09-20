import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../../i18n";
import { DialogContainerExamples } from "./dialog-containers";

/**
 * Base UI P2 分区：通用对话框容器。
 *
 * 这一层的职责是「由基元组装、契约不含业务语义」，且业务域已按 L 系分区拆走：
 * 数据与集合容器归 Data 分区，文件树归 File L1/L2，文件预览归 Preview L1/L2，
 * 本分区只留与业务无关的对话框容器 —— 确认流程与表单流程。
 *
 * 共同边界不变：数据与异步流程全部由调用方注入，容器只管结构、状态分支与焦点/禁用这类交互约定，
 * 因此示例里的数据全是静态假数据。
 *
 * 内容拆到同目录文件，本入口只负责分区标题、说明与拼接：
 * - dialog-containers：ConfirmDialog / FormDialog
 */

export function BaseUiP2Section() {
  const { t } = useTranslation(DEMO_NS);

  return (
    <section className="demo-section">
      <h1 className="demo-section-title">{t("sections.baseUiP2")}</h1>
      <p className="demo-hint">{t("sectionHints.baseUiP2")}</p>

      <DialogContainerExamples />
    </section>
  );
}
