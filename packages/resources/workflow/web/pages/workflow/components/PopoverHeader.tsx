/**
 * 弹层头：`wf-popover-header` + `wf-popover-title` 这两行骨架（类样式在 `pages/workflow/workflow.css`）。
 *
 * 为什么共享：这三行 JSX 此前在三个弹层里逐字重复——文件菜单（`WorkflowEditor`）、版本指示器
 * （`VersionIndicator`）、工作流元数据（`WorkflowMetaPopover`）。内衬、标题字号与分隔线都由 CSS 类给出，
 * 共享件只保住「标题行就是这两个类」这一件事，取词与取值留在调用点（三处读的是各自的 key）。
 *
 * 为什么不带类型徽标（`wf-popover-type`）与删除按钮：真实用到它们的两处是节点配置的弹层与 Sheet
 * （`NodeConfigPopover` / `NodeConfigSheet`）——它们属于已裁定的「三容器刻意分叉」，且头部 DOM 不同
 * （Sheet 走 Radix 的 `SheetHeader` / `SheetTitle`，不是一个 `div`），仍各自手写；此处提前长出没有消费方的
 * 参数只会把内部结构固化成公共契约（`web/index.ts` 的「按消费方实际需要收敛」）。
 */
export function PopoverHeader({ title }: { title: React.ReactNode }) {
  return (
    <div className="wf-popover-header">
      <span className="wf-popover-title">{title}</span>
    </div>
  );
}
