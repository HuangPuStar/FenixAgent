/**
 * 参数分组的折叠标题行：`▶ 组名`（折叠时补一个条数徽标），整行可点，点击切换展开态。
 *
 * 为什么共享：这段样式块（13 个属性的行样式 + `▶` 的旋转变换）此前在 `ParamsEditor` 与
 * `RunParamsDialog` 各写一份，逐字相同，只有「展开态由谁持有」不同——`ParamsEditor` 用页面上的
 * `collapsedGroups` 集合（还要在折叠态显示条数），`RunParamsDialog` 用组件内的 `useState`。
 * 因此共享件是**受控**的：展开态与点击行为都由调用方给，这里只负责那一行的呈现。
 *
 * 为什么用 `open`（而不是 `collapsed`）作受控值：两处的 `▶` 都是「展开时转 90°」，
 * `ParamsEditor` 传 `open={!isCollapsed}` 即可，避免同一语义在两边用相反的布尔表达。
 *
 * 为什么不并进调用点各自的容器：两处容器刻意不同——`ParamsEditor` 的分组在 `marginBottom: 4` 的
 * 盒子里、子项 `gap: 4`（编辑器面板更紧），`RunParamsDialog` 是 `marginBottom: 8` / `gap: 12`
 * （弹窗更松），行容器与子项间距不共享，只共享标题行。
 */
export function ParamGroupHeader({
  label,
  open,
  count,
  onToggle,
}: {
  label: React.ReactNode;
  open: boolean;
  /** 折叠时显示的条数徽标；不传则不显示（轻量分组不需要）。 */
  count?: number;
  onToggle: () => void;
}) {
  return (
    <div
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        cursor: "pointer",
        fontWeight: 600,
        color: "#374151",
        fontSize: 12,
        padding: "6px 0",
        borderBottom: "1px solid #e5e7eb",
        marginBottom: 4,
      }}
    >
      <span style={{ fontSize: 10, transition: "transform 0.15s", transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>
        ▶
      </span>
      {label}
      {!open && count !== undefined && (
        <span style={{ fontWeight: 400, color: "#9ca3af", marginLeft: 4 }}>({count})</span>
      )}
    </div>
  );
}
