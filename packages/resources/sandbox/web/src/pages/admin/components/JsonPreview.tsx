// 管理面板里的「原样 JSON」展示块。
//
// 2026-09-22 前端去重：Provider 原始返回值、实例详情（environment / volumes）与远程实例诊断这四处
// 各写了一份 `<pre className="… overflow-auto whitespace-pre-wrap break-all rounded bg-muted text-xs">`
// ——类名逐字相同，只差 `max-h-*` 与内边距；`JSON.stringify(value, null, 2)` 也各自抄了一遍。
//
// 为什么不做成 `@fenix/ui-components` 的通用组件：目前只有 sandbox 管理面板消费（宿主与其它资源包
// 看 JSON 走的是各自的诊断入口）；等第二个包出现时再上移，避免通用层先长出一个只有一处用的组件。
//
// 无障碍：`<pre>` 的 role 是 generic，不支持 `aria-label`；这几处的语境都由相邻 `<Label>` 或
// 弹窗标题提供，块本身不需要再命名，故不额外加属性。

import { cn } from "@fenix/ui-components/lib/cn";

export interface JsonPreviewProps {
  /** 任意结构化数据；按 `JSON.stringify(value, null, 2)` 原样展示，不解析字段。 */
  value: unknown;
  /** 高度上限与布局微调（如 `max-h-56` / `mt-1 max-h-32`）；与基础类名合并去重。 */
  className?: string;
}

export function JsonPreview({ value, className }: JsonPreviewProps) {
  return (
    <pre
      className={cn("max-w-full overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs", className)}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
