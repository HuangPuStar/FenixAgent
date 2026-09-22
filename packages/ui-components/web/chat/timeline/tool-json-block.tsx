import type * as React from "react";
import { cn } from "../../lib/cn";

/**
 * 工具详情弹窗里的「JSON 字段块」：大写小标题 + 等宽预格式正文（错误态换红底）。
 *
 * 2026-09-22 前端去重：`HindsightToolCard` 与 `ToolCallRow` 的详情弹窗此前各写一份同样的骨架
 * （小标题 `text-[9px] font-semibold uppercase tracking-widest text-text-dim mb-1.5` +
 * 正文 `text-[11px] ... font-mono leading-relaxed` + 出错时的 `bg-status-error/6 text-status-error`），
 * 入参/出参各一处、共 4 处调用；两边的 `truncate(JSON.stringify(input, null, 2), 3000)` 也是同一句。
 * 合并后「详情块长什么样」只有一处定义。
 *
 * 合并时确定的换行策略：按 `ToolCallRow` 的 `whitespace-pre-wrap break-all [tab-size:2]`——
 * `HindsightToolCard` 此前是横向滚动（`overflow-auto` 无折行），长 JSON 在窄弹窗里要左右拖。
 * 折行后两处的观感一致，也不需要再给 `pre` 单独设宽度。
 *
 * 标题文案仍由调用方给、不在这里绑定 i18n：`HindsightToolCard` 的弹窗沿用源实现的硬编码文案
 * （该文件头已声明「源内硬编码，逐字保留」），`ToolCallRow` 走自己的 `t()` key，两边不一致是既有事实，
 * 本批不顺手改文案。
 */
export function ToolJsonBlock({
  label,
  content,
  error = false,
}: {
  /** 小标题（入参 / 出参），由调用方给已处理的文案。 */
  label: React.ReactNode;
  /** 已序列化并截断的正文。 */
  content: string;
  /** 出错结果：正文换红底红字（入参块永远为 false）。 */
  error?: boolean;
}) {
  return (
    <div>
      <div className="text-[9px] font-semibold uppercase tracking-widest text-text-dim mb-1.5">{label}</div>
      <pre
        className={cn(
          "text-[11px] rounded-md px-3 py-2.5 overflow-auto font-mono leading-relaxed whitespace-pre-wrap break-all [tab-size:2]",
          error ? "bg-status-error/6 text-status-error" : "bg-surface-2 text-text-secondary",
        )}
      >
        {content}
      </pre>
    </div>
  );
}
