// 品牌 Agent 头像 — 多圆+连线组成网络节点图案
// lucide-react 无对应图标，图案本体集中在 `./internal/agent-logo.tsx`

import { cn } from "../../lib/cn";
import { AgentLogo } from "./internal/agent-logo";

/**
 * AgentAvatar 属性。
 * 复制自 `packages/agent-runtime/web/components/chat/AgentAvatar.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）；纯化改动点：无。
 */
interface AgentAvatarProps {
  className?: string;
}

/**
 * 品牌 Agent 头像（多圆 + 连线组成的网络节点图案）。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/AgentAvatar.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 * 纯化改动点：`cn` 由宿主 `@/src/lib/utils` 改为包内 `../../lib/cn`。
 * 内联 SVG 改为 `./internal/agent-logo`（2026-09-22 库内去重，尺寸 20 不变）。
 */
export function AgentAvatar({ className }: AgentAvatarProps) {
  return (
    <div className={cn("w-8 h-8 rounded-lg bg-brand/8 items-center justify-center flex-shrink-0", className)}>
      <AgentLogo size={20} />
    </div>
  );
}
