/**
 * 品牌 Agent 徽记 — 多圆 + 连线组成的网络节点图案。
 *
 * lucide-react 无对应图标，故以独立组件集中管理（不引入新依赖，也不各自内联一份）。
 * 2026-09-22 库内去重：`chat/shell/AgentAvatar.tsx` 与 `chat/shell/AgentBadge.tsx` 此前各内联了
 * 一份逐字相同的 8 个 SVG 元素（唯一差异是 `<svg>` 的 `width` / `height`），收敛到此并以 `size` 参数化。
 *
 * 颜色走 `var(--color-brand)`，与两侧原本的写法一致；`viewBox` / `fill` / `aria-hidden` 逐字保留。
 */
export function AgentLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="6" r="2.5" fill="var(--color-brand)" />
      <circle cx="6" cy="16" r="2.5" fill="var(--color-brand)" opacity=".85" />
      <circle cx="18" cy="16" r="2.5" fill="var(--color-brand)" opacity=".85" />
      <circle cx="12" cy="12" r="1.5" fill="var(--color-brand)" opacity=".6" />
      <line x1="12" y1="8.5" x2="12" y2="10.5" stroke="var(--color-brand)" strokeWidth="1.2" opacity=".5" />
      <line x1="12" y1="13.5" x2="7.2" y2="15.2" stroke="var(--color-brand)" strokeWidth="1.2" opacity=".5" />
      <line x1="12" y1="13.5" x2="16.8" y2="15.2" stroke="var(--color-brand)" strokeWidth="1.2" opacity=".5" />
      <line x1="8.2" y1="16" x2="15.8" y2="16" stroke="var(--color-brand)" strokeWidth="1" opacity=".3" />
    </svg>
  );
}
