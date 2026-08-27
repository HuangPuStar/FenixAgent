import type { ReactNode } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";

type AgentMasterDetailWorkspaceProps = {
  index: ReactNode;
  detailHeader?: ReactNode;
  children: ReactNode;
  className?: string;
};

/** Shared scrolling boundary for catalog and administration master-detail pages. */
export function AgentMasterDetailWorkspace({
  index,
  detailHeader,
  children,
  className,
}: AgentMasterDetailWorkspaceProps) {
  return (
    <section
      className={`grid h-[calc(100dvh-210px)] min-h-[480px] min-w-0 grid-cols-[238px_minmax(0,1fr)] overflow-hidden rounded-[10px] bg-white shadow-[0_12px_38px_rgb(36_57_92_/_8%)] max-[760px]:grid-cols-1 ${className ?? ""}`}
    >
      <ScrollArea className="min-h-0 bg-[#f6f8fb] shadow-[inset_-1px_0_#e7ecf3]">{index}</ScrollArea>
      <div className="flex min-h-0 min-w-0 flex-col">
        {detailHeader ? <div className="shrink-0 bg-white">{detailHeader}</div> : null}
        <ScrollArea className="min-h-0 min-w-0 flex-1">{children}</ScrollArea>
      </div>
    </section>
  );
}

/** Normalizes detail header sizing without coupling it to scrolling behavior. */
export function AgentMasterDetailHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <header className={`bg-white ${className ?? ""}`}>{children}</header>;
}
