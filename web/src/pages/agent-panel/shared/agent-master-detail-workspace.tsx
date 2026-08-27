import type { ReactNode } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";

type AgentMasterDetailWorkspaceProps = {
  index: ReactNode;
  children: ReactNode;
  className?: string;
};

/** Shared scrolling boundary for catalog and administration master-detail pages. */
export function AgentMasterDetailWorkspace({ index, children, className }: AgentMasterDetailWorkspaceProps) {
  return (
    <section
      className={`grid h-[calc(100dvh-210px)] min-h-[480px] min-w-0 grid-cols-[238px_minmax(0,1fr)] overflow-hidden rounded-[10px] bg-white shadow-[0_12px_38px_rgb(36_57_92_/_8%)] max-[760px]:grid-cols-1 ${className ?? ""}`}
    >
      <ScrollArea className="min-h-0 bg-[#f6f8fb] shadow-[inset_-1px_0_#e7ecf3]">{index}</ScrollArea>
      <ScrollArea className="min-h-0 min-w-0">{children}</ScrollArea>
    </section>
  );
}

/** Keeps the selected resource identity visible while its detail body scrolls. */
export function AgentMasterDetailHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`sticky top-0 z-10 bg-white ${className ?? ""}`}>{children}</div>;
}
