import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";

interface CollapsibleSidePanelProps {
  panelOpen: boolean;
  onPanelOpenChange: (open: boolean) => void;
  toggleLabel: string;
  sidebar: ReactNode;
  children: (height: number) => ReactNode;
}

/**
 * 可折叠侧栏容器：主区域自适应测量 + 右侧抽屉式侧栏。
 *
 * 来源与纯化取舍：逐字复制自
 * `packages/resources/memory/web/pages/hindsight/components/MemoryVisualizationShell.tsx`，
 * 仅做最小必要改写——去掉记忆图谱领域的命名与注释
 * （`MemoryVisualizationShell` → `CollapsibleSidePanel`、`MemoryVisualizationShellProps`
 * → `CollapsibleSidePanelProps`），并把宿主别名 `@/components/ui/button` 改为包内相对
 * 路径 `../ui/button`。业务逻辑、样式类名、DOM 结构均未改动。
 *
 * 已知限制：
 * - `children` 采用“测量式渲染”契约（接收主区域实测高度，单位为 px，初始值 1），用于画布类
 *   子组件按容器高度自绘；调用方需自行处理高度为 1 的首帧。
 * - 侧栏折叠使用 `md:` 断点：小屏下侧栏宽度恒为 0，仅桌面端展开，未提供移动端抽屉替代。
 * - 折叠动画依赖 `transition-[width]`，无 `prefers-reduced-motion` 降级。
 */
export function CollapsibleSidePanel({
  panelOpen,
  onPanelOpenChange,
  toggleLabel,
  sidebar,
  children,
}: CollapsibleSidePanelProps) {
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
