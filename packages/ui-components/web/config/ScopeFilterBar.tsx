import { Search } from "lucide-react";
import type * as React from "react";

import { cn } from "../lib/cn";

/** 作用域过滤条的一个选项；`value` 由调用方定义（如 `all` / `organization` / `public`）。 */
export interface ScopeFilterOption {
  value: string;
  label: React.ReactNode;
  /** 该作用域命中条数；给了就渲染在标签后。 */
  count?: number;
}

export interface ScopeFilterBarProps extends Omit<React.ComponentProps<"div">, "onChange"> {
  /** 搜索框受控值。 */
  query: string;
  onQueryChange: (query: string) => void;
  /** 搜索框占位文案（调用方 i18n）。 */
  placeholder: string;
  /** 搜索框 aria-label（调用方 i18n）。 */
  searchLabel: string;
  /** 作用域选项，按渲染顺序。 */
  scopes: readonly ScopeFilterOption[];
  /** 当前作用域（受控）。 */
  scope: string;
  onScopeChange: (scope: string) => void;
  /** 作用域按钮组 aria-label（调用方 i18n）。 */
  scopeGroupLabel: string;
}

/**
 * 目录页的「搜索框 + 作用域过滤条」：一行内左侧搜索、右侧分段式作用域切换。
 *
 * 为什么放在 `config/`：它是**配置型目录页**的公共骨架——MCP、技能、模型三个目录页此前各写了一份
 * 逐字重复的 JSX 与三份关键声明逐行相同的 CSS（`*-commandbar` / `*-search-field` / `*-scope-filter`），
 * 差异只在文案、作用域取值与计数值，也就是调用方本来就该传的东西。它不含业务状态（不认识「组织 / 公开」
 * 是什么，也不做过滤），只负责把受控的 query / scope 渲染成统一形态，因此属于配置型容器层而非业务组件。
 *
 * 组件内**不接 i18n**：文案（`placeholder` / `searchLabel` / `scopeGroupLabel` / 每个 `label`）全部由
 * props 传入。库内组件一旦自带命名空间，就会把 `@fenix/ui-components` 的 i18n 与调用方业务包的 key 绑在
 * 一起，同一处文案在库与业务两侧各留一份；这里保持纯展示，key 与语言资源只存在于调用方。
 *
 * 无障碍契约（与三处调用点的现状一致）：作用域按钮组是 `role="group"` + `aria-label`，每个按钮
 * `aria-pressed` 表达选中态；搜索框用 `aria-label` 命名（视觉上只有图标，没有可见 label）。
 * 调用方需要保留「工具栏」这一类地标时可传 `role` 与 `aria-label`（本组件透传根节点的 `<div>` 属性）。
 *
 * 样式归一化的取舍（2026-09-22 前端去重，三处原值不同者取标准刻度）：
 * - 宽度 `min(560px, 100%)` → `max-w-xl`（576px），13px 输入字号 → `text-sm`，10px 计数 → `text-xs`；
 * - 高度 40px / 32px → `h-10` / `h-8`，圆角 8px / 6px → `rounded-md` / `rounded-sm`（与库内
 *   `ui/button`、`ui/input` 同刻度），左内边距 41px → `pl-10`；
 * - 品牌蓝 `#2463eb`、灰底 `#e9edf4`、淡字 `#96a2b5` 等硬编码色 → `brand` / `surface-2` / `text-muted`
 *   等 token；
 * - 响应式断点由三处各自的 900 / 720 / 980px 统一为规范断点 `md`（768px）：`md` 以下竖排，
 *   作用域组横向可滚（`overflow-x-auto` 常驻，宽度不够时滚动而不是把整行撑破）。
 *
 * 刻意不写 `dark:` 变体：本仓库的暗色是 `.dark` 类切换，而 Tailwind 默认的 `dark` 变体是媒体查询，
 * 两者并不等价（写 `dark:` 会跟随系统偏好而非页面主题）。选中态因此只用「轨底色 `surface-2` + 白色药丸
 * `surface-1`」这一组同向 token 表达；暗色下药丸比轨底色深一档但仍可辨识（另有 `shadow-sm` 分层）。
 */
export function ScopeFilterBar({
  query,
  onQueryChange,
  placeholder,
  searchLabel,
  scopes,
  scope,
  onScopeChange,
  scopeGroupLabel,
  className,
  ...props
}: ScopeFilterBarProps) {
  return (
    <div
      className={cn("mt-3.5 mb-4 flex flex-col items-stretch gap-3 md:flex-row md:items-center", className)}
      {...props}
    >
      {/* `<label>` 保留原结构：图标是装饰（`pointer-events-none` 让点击穿透到输入框），
          输入框的可访问名由 `aria-label` 提供。 */}
      <label className="relative block w-full max-w-xl">
        <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <input
          aria-label={searchLabel}
          value={query}
          placeholder={placeholder}
          onChange={(event) => onQueryChange(event.target.value)}
          className="h-10 w-full rounded-md border border-border bg-surface-1 pr-3.5 pl-10 text-sm text-text-bright outline-none transition-shadow placeholder:text-text-dim focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-[var(--color-brand-glow)]"
        />
      </label>
      <div
        role="group"
        aria-label={scopeGroupLabel}
        className="flex h-10 w-max max-w-full min-w-0 items-center gap-0.5 overflow-x-auto rounded-md bg-surface-2 p-1"
      >
        {scopes.map((option) => {
          const selected = option.value === scope;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => onScopeChange(option.value)}
              className={cn(
                "h-8 shrink-0 rounded-sm bg-transparent px-3 text-xs whitespace-nowrap text-text-secondary transition-colors",
                selected && "bg-surface-1 font-semibold text-brand shadow-sm",
              )}
            >
              {option.label}
              {option.count !== undefined && <span className="ml-1 text-xs text-text-muted">{option.count}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
