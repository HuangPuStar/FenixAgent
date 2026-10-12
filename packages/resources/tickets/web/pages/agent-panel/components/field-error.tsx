/**
 * 表单字段错误行：本包所有 zod 校验错误的唯一渲染点（创建工单、编辑字段、评论表单共用）。
 *
 * 为什么必须渲染在 `LabeledField` **之外**：`LabeledField` 会把子节点并入控件的可访问名，错误文案
 * 混进名字后，读屏用户听到的字段名会随校验状态变化。
 *
 * 为什么入参是**键**而不是文案：zod 的 message 是裸字符串，组件层才持有 `t()`；把中文写进 schema 会让
 * 文案绕过 i18n、切语言后不跟随（`tickets-i18n` 的扫描用例专门钉住这一条）。
 */

import { useTranslation } from "react-i18next";
import { TICKETS_NS } from "../../../i18n/namespace";

export function FieldError({ messageKey }: { messageKey?: string }) {
  const { t } = useTranslation(TICKETS_NS);
  if (messageKey === undefined) return null;
  return (
    <p className="mt-1 text-xs text-status-error" role="alert">
      {t(messageKey)}
    </p>
  );
}
