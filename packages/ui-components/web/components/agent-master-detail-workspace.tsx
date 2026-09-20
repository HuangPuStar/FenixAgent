import type { ReactNode } from "react";
import { ScrollArea } from "../ui/scroll-area";

type AgentMasterDetailWorkspaceProps = {
  index: ReactNode;
  detailHeader?: ReactNode;
  detailFooter?: ReactNode;
  children: ReactNode;
  className?: string;
};

/**
 * Shared scrolling boundary for catalog and administration master-detail pages.
 *
 * 已知限制：外层投影 `shadow-[0_12px_38px_rgb(36_57_92_/_8%)]` 在包内没有等价阴影 token
 * （shadow-elevated 的扩散与颜色不同），为不改动视觉而逐字保留。
 * 影响范围：仅本节点的外层投影；索引栏内嵌分隔线已改为 `var(--color-border)`，深色主题下自动跟随。
 * 移除条件：当主题 token 中补充了与源视觉等价的阴影变量后，改为引用该变量。
 */
export function AgentMasterDetailWorkspace({
  index,
  detailHeader,
  detailFooter,
  children,
  className,
}: AgentMasterDetailWorkspaceProps) {
  return (
    <section
      className={`grid h-[calc(100dvh-210px)] min-h-[480px] min-w-0 grid-cols-[238px_minmax(0,1fr)] overflow-hidden rounded-[10px] bg-surface-1 shadow-[0_12px_38px_rgb(36_57_92_/_8%)] max-[760px]:grid-cols-1 ${className ?? ""}`}
    >
      <ScrollArea className="min-h-0 bg-surface-0 shadow-[inset_-1px_0_var(--color-border)]">{index}</ScrollArea>
      <div className="flex min-h-0 min-w-0 flex-col">
        {detailHeader ? <div className="shrink-0 bg-surface-1">{detailHeader}</div> : null}
        <ScrollArea className="min-h-0 min-w-0 flex-1">{children}</ScrollArea>
        {detailFooter ? <div className="shrink-0 bg-surface-1">{detailFooter}</div> : null}
      </div>
    </section>
  );
}

/** Normalizes detail header sizing without coupling it to scrolling behavior. */
export function AgentMasterDetailHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <header className={`bg-surface-1 ${className ?? ""}`}>{children}</header>;
}
