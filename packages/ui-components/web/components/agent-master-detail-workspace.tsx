import type { ReactNode } from "react";
import { ScrollArea } from "../ui/scroll-area";
import "./agent-master-detail-workspace.css";

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
 * 高度（`calc(100dvh - 210px)`）、两列定义（`238px minmax(0, 1fr)`）与外层投影都下沉到
 * `agent-master-detail-workspace.css` 的 `.agent-master-detail-workspace`；
 * 其中投影的已知限制、影响范围与移除条件记在该 CSS 文件里。
 * 窄屏单列仍由下面 className 里的 `max-md:grid-cols-1` 表达，与之互补的媒体查询在 CSS 侧。
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
      className={`agent-master-detail-workspace grid min-h-120 min-w-0 overflow-hidden rounded-lg bg-surface-1 max-md:grid-cols-1 ${className ?? ""}`}
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
