// 品牌 Agent 头像 — 多圆+连线组成网络节点图案
// lucide-react 无对应图标，图案本体集中在 `./internal/agent-logo.tsx`

import { cn } from "../../lib/cn";
import { AgentLogo } from "./internal/agent-logo";

/**
 * AgentAvatar 属性。
 * 复制自 `packages/agent-runtime/web/components/chat/AgentAvatar.tsx`；纯化改动点：无。
 */
interface AgentAvatarProps {
  className?: string;
}

/**
 * 品牌 Agent 头像（多圆 + 连线组成的网络节点图案）。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/AgentAvatar.tsx`。
 * 纯化改动点：`cn` 由宿主 `@/src/lib/utils` 改为包内 `../../lib/cn`。
 * 内联 SVG 改为 `./internal/agent-logo`（2026-09-22 库内去重，尺寸 20 不变）。
 */
export function AgentAvatar({ className }: AgentAvatarProps) {
  return (
    <div
      // agent-avatar：作为窄屏容器（如 MetaAgentPanel）隐藏头像的 CSS 作用域钩子
      className={cn("agent-avatar w-8 h-8 rounded-lg bg-brand/8 items-center justify-center flex-shrink-0", className)}
    >
      <AgentLogo size={20} />
    </div>
  );
}
