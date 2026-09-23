import { Button } from "@fenix/ui-components/ui/button";
import { X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * 面板头：一处实现，三个消费方（`RunListPanel` 运行记录 / `TriggerPanel` Webhook 触发器 /
 * `VersionPanel` 版本管理）。
 *
 * 三处原先各写一份，且是**逐字重复**：同一个 `wf-prop-header` 外壳 + 同一串 `display:flex;
 * align-items:center; justify-content:space-between` 内联样式 + 同一个 `wf-prop-title` 标题 +
 * 同一个手写关闭按钮（三份 style 对象逐字相同：24×24、`#f3f4f6` 底、`#6b7280` 字、`X size={11}`）。
 * 真差异只有两处，留成 props：
 * - `title` / `icon`：只有触发器面板在标题前带一个 `Globe` 图标，另两处是纯文本。
 * - `closeLabel`：关闭按钮是纯图标按钮，可访问名只能由 `aria-label` 提供。三处读的 key 不同
 *   （`editor.run_panel_close` / `editor.trigger_panel_close` / `editor.version_panel_close`），
 *   沿用包内「文案由调用方翻译后传入」的惯例（同 `VersionRow` 的 `labels`）——key 是翻译资源的引用，
 *   共享件自带 key 等于替三个面板重指文案，超出收敛重复的范围。
 *
 * 有意归一化（三处本就同源，取同一刻度）：
 * - 关闭按钮改用 `ui/button` 的 `variant="secondary" size="icon-xs"`（库内唯一按钮实现，§4.1）：
 *   `icon-xs` 的 24×24 与原内联写法同尺寸，底色 `#f3f4f6` → `bg-secondary`（#f1f5f9，dark 变体由
 *   token 承担），圆角 4px → `rounded-md`（6px），`X` 写死的 11px → `icon-xs` 的 `size-3`（12px）。
 *   顺带获得 hover / focus-visible 反馈——原三处都没有任何交互态，键盘 Tab 到关闭按钮时没有可见提示。
 * - 图标与标题的对齐改用 `inline-flex items-center gap-1`：原触发器的 `verticalAlign: -1` +
 *   `marginRight: 4` 是两个内联 hack，flex 下同义且不需要写盒子模型。标题短、无换行需求，
 *   纯文本标题在 `inline-flex` 里渲染结果不变。
 */
export interface PanelHeaderProps {
  /** 面板标题（调用方已翻译）。 */
  title: ReactNode;
  /** 标题前的图标，可选（触发器面板传 `Globe`）。 */
  icon?: ReactNode;
  /** 关闭按钮的可访问名（调用方已翻译）。 */
  closeLabel: string;
  onClose: () => void;
}

export function PanelHeader({ title, icon, closeLabel, onClose }: PanelHeaderProps) {
  return (
    <div className="wf-prop-header flex items-center justify-between">
      <span className="wf-prop-title inline-flex items-center gap-1">
        {icon}
        {title}
      </span>
      {/* 纯图标按钮：可访问名只能由 aria-label 提供（面板标题已由 wf-prop-title 承载，X 只表示关闭） */}
      <Button variant="secondary" size="icon-xs" onClick={onClose} aria-label={closeLabel}>
        <X />
      </Button>
    </div>
  );
}
