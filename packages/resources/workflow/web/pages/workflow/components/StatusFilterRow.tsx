import { cn } from "@fenix/ui-components/lib/cn";

/**
 * 状态筛选按钮行：一处实现，两个消费方（`WorkflowRuns` 运行记录页的工具栏 / `RunListPanel`
 * 编辑器运行记录面板）。
 *
 * 两处原先是**同构**的：同一组状态值、同一个「选中态 → 计数/切换」交互，连 `all` 分支的 key
 * （`runs.filter_all`）都相同；差异只在三处，逐个留成 props / 归一化：
 * - **取词路径不同**：运行页读 `runs.status_*`（`STATUS_LABEL_KEYS`），面板读 `editor.dag_status_*`
 *   （`DAG_STATUS_CFG[s].labelKey`）。两族文案逐字相同，但 key 是翻译资源的引用，换族等于替两个页面
 *   重指文案——因此**不合并字典**，由调用方把 label 翻译好后经 `options` 传入（同 `ScopeFilterBar`
 *   的「组件不接 i18n」口径），key 族留在各自调用点。`options` 用的是同一份状态值表
 *   （`RUN_STATUS_FILTERS`），顺序与取值本就是真重复，收在这里。
 * - **容器外壳不同**：运行页的按钮行直接坐在工具栏 flex 里（无内衬、无边框），面板的是「面板的一段」
 *   （`padding: 6px 12px` + 下边框）。外壳经 `className` 传入，由调用方表达。
 * - **视觉体系不同**：运行页已用 token 类，面板还是内联十六进制值（`#eff6ff` / `#3b82f6` / `#e5e7eb`）。
 *   统一取运行页那份（token 类，与包内其它已迁移处同刻度，§10）：底色/边框/文字走
 *   `border-brand` / `bg-brand-subtle` / `text-brand` 与 `border-border-subtle` / `bg-surface-1` /
 *   `text-text-secondary`，字号 11px / 10px → `text-xs`（12px，标准刻度；面板那份的 10px 与运行页的
 *   `text-[11px]` 都是任意值，收进刻度后不再有任意值）。圆角 4px → `rounded-md`，内衬统一
 *   `px-2.5 py-1`。
 * - `flex-wrap` 从面板那份上提到基础类：300px 侧栏里五个按钮本就必然换行（原实现即 `flexWrap: "wrap"`），
 *   运行页在宽容器里不受影响，只在极窄视口下由「溢出」变为「换行」。
 *
 * 另外补上 `aria-pressed`：选中态原先只由颜色表达，读屏读不出当前筛选。这是按钮行自己的语义，
 * 两个消费方同收益，与文案无关。
 */
export interface StatusFilterOption {
  /** 状态值（`all` 表示不过滤）。 */
  value: string;
  /** 按钮文案（调用方已翻译）。 */
  label: string;
}

/**
 * 状态筛选项与顺序：两个消费方的取值与顺序逐字相同，收在这里，避免第三个消费方再抄一遍。
 * `all` 是「不过滤」项，不是 `DAGStatus` 取值，因此不放进 `DAG_STATUS_CFG`。
 */
export const RUN_STATUS_FILTERS = ["all", "RUNNING", "SUSPENDED", "SUCCESS", "FAILED"] as const;

export interface StatusFilterRowProps {
  /** 当前选中值（受控）。 */
  value: string;
  /** 选项表：值与已翻译文案。 */
  options: ReadonlyArray<StatusFilterOption>;
  onChange: (value: string) => void;
  /** 外壳补充类（面板用它表达「一段」的内衬与下边框）。 */
  className?: string;
}

export function StatusFilterRow({ value, options, onChange, className }: StatusFilterRowProps) {
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              active
                ? "border-brand bg-brand-subtle text-brand"
                : "border-border-subtle bg-surface-1 text-text-secondary hover:bg-surface-hover",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
