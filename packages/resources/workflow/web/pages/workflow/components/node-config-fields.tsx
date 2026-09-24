import { Textarea } from "@fenix/ui-components/ui/textarea";
import { Maximize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ExpandState } from "./expand-field-dialog";

/**
 * 节点配置卡片里的两种字段外形。
 *
 * 从 `NodeConfigCard` 抽出，因为按节点类型分开的分区组件（`node-config-*-section(s).tsx`）
 * 全都要用它们：`BlockField` 是带「展开」入口的代码块，`InlineField` 是标签与控件同排的一行。
 * 两者的 DOM 结构就是各分区共用的那份样式配方（`wf-prop-field-block` / `wf-prop-field-inline`），
 * 改一处即改全部，所以留在一个文件里。
 *
 * 折叠容器 `CollapsibleGroup` 不在本文件：它与运行参数弹窗的分组容器是同一种东西，
 * 2026-09-23（第 19 轮）已收敛为 `./CollapsibleGroup` 一份实现。
 */

/**
 * 代码块字段：多行文本 + 右上角的「展开编辑」按钮。
 *
 * 展开态不在这里持有——`onExpand` 把 `ExpandState` 交给卡片顶层的 `ExpandFieldDialog`，
 * 保持「一张卡片一个展开弹窗」的既有形态。
 */
export function BlockField({
  label,
  value,
  onChange,
  readOnly,
  onExpand,
  placeholder,
  rows,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  readOnly: boolean;
  onExpand: (state: ExpandState) => void;
  placeholder?: string;
  rows?: number;
}) {
  const { t } = useTranslation("workflows");

  return (
    <div className="wf-prop-field-block">
      <div className="wf-prop-field-block-header">
        <label>{label}</label>
        <button
          type="button"
          className="wf-prop-expand-btn"
          title={t("editor.expand_edit")}
          onClick={() => onExpand({ label, value, onChange, placeholder })}
        >
          <Maximize2 size={12} />
        </button>
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows ?? 3}
        readOnly={readOnly}
        className="font-mono text-xs"
      />
    </div>
  );
}

/** 横向字段：标签与控件同排。 */
export function InlineField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="wf-prop-field-inline">
      <label>{label}</label>
      {children}
    </div>
  );
}
