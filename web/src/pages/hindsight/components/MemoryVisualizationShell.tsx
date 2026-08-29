import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

interface MemoryVisualizationShellProps {
  panelOpen: boolean;
  onPanelOpenChange: (open: boolean) => void;
  toggleLabel: string;
  sidebar: ReactNode;
  children: (height: number) => ReactNode;
}

/** 为记忆图谱视图提供统一、自适应且无外溢的可视化容器。 */
export function MemoryVisualizationShell({
  panelOpen,
  onPanelOpenChange,
  toggleLabel,
  sidebar,
  children,
}: MemoryVisualizationShellProps) {
  const graphicRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(1);

  useEffect(() => {
    const element = graphicRef.current;
    if (!element) return;
    const updateHeight = () => {
      const nextHeight = Math.floor(element.getBoundingClientRect().height);
      if (nextHeight > 0) setHeight(nextHeight);
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="flex h-full min-h-0 min-w-0 overflow-hidden rounded-lg border border-border bg-background">
      <div ref={graphicRef} className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">
        {children(height)}
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => onPanelOpenChange(!panelOpen)}
        title={toggleLabel}
        aria-label={toggleLabel}
        className="hidden h-full w-5 shrink-0 rounded-none border-l md:inline-flex"
      >
        {panelOpen ? <ChevronRight className="size-3" /> : <ChevronLeft className="size-3" />}
      </Button>
      <div
        className={`${panelOpen ? "md:w-80 md:border-l" : "md:w-0"} h-full min-h-0 w-0 shrink-0 overflow-hidden bg-card transition-[width] duration-300`}
      >
        <div className="h-full w-80 overflow-y-auto">{sidebar}</div>
      </div>
    </div>
  );
}
