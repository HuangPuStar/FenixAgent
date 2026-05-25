// 品牌 Agent 头像 — 多圆+连线组成网络节点图案
// lucide-react 无对应图标，提取为独立组件集中管理

import { cn } from "../../src/lib/utils";

interface AgentAvatarProps {
  className?: string;
}

export function AgentAvatar({ className }: AgentAvatarProps) {
  return (
    <div className={cn("w-8 h-8 rounded-lg bg-brand/8 items-center justify-center flex-shrink-0", className)}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="6" r="2.5" fill="var(--color-brand)" />
        <circle cx="6" cy="16" r="2.5" fill="var(--color-brand)" opacity=".85" />
        <circle cx="18" cy="16" r="2.5" fill="var(--color-brand)" opacity=".85" />
        <circle cx="12" cy="12" r="1.5" fill="var(--color-brand)" opacity=".6" />
        <line x1="12" y1="8.5" x2="12" y2="10.5" stroke="var(--color-brand)" strokeWidth="1.2" opacity=".5" />
        <line x1="12" y1="13.5" x2="7.2" y2="15.2" stroke="var(--color-brand)" strokeWidth="1.2" opacity=".5" />
        <line x1="12" y1="13.5" x2="16.8" y2="15.2" stroke="var(--color-brand)" strokeWidth="1.2" opacity=".5" />
        <line x1="8.2" y1="16" x2="15.8" y2="16" stroke="var(--color-brand)" strokeWidth="1" opacity=".3" />
      </svg>
    </div>
  );
}
