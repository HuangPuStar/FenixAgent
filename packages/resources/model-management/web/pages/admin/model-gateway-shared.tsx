/**
 * 模型网关管理面的包内共享件（`AdminModelGatewayPage.tsx` + `ModelGatewayKeyManagementPanel.tsx`）。
 *
 * 收口的三段逐字重复——它们此前在两张表 / 三个按钮上各写一份，改一处样式就要手工同步其余几处：
 * - **表格骨架**：`div.overflow-x-auto.rounded-md.border` + `table.w-full.text-left.text-sm`
 *   + `thead.bg-muted/40` + `tbody.divide-y` + 单元格 `px-3 py-2`。密钥表与模型表逐字相同，
 *   只有列定义与行内容不同；预算表用的是另一套骨架（`table-fixed` / 带 `font-medium` 的表头），
 *   因此只共用最外层的容器类。
 * - **「筛选后没有匹配」占位行**：`tr > td[colSpan] > EmptyState`，模型表与预算表各一份，
 *   只有列数不同。
 * - **卡片头部的刷新按钮**：`outline` 小按钮 + 随请求态转圈的 `RefreshCw`，三处。
 *
 * 不下沉 `@fenix/ui-components`：两个消费方同属本包同一屏（§4.1「归属由消费者集合决定」），
 * 库内没有第二个消费者，上移只会形成无人使用的公共面。
 *
 * 密钥表与模型表**不是**两份实现：密钥表的唯一实现是 `ModelGatewayKeyManagementPanel`，
 * 由本页以 `<ModelGatewayKeyManagementPanel>` 消费（同一个组件、同一份状态与请求）。
 *
 * 2026-09-23 §4.8 拆分时又并进来两段「同屏多处逐字相同」的东西（原先躺在 `AdminModelGatewayPage.tsx` 里）：
 * 三个原生表单控件的类串与指标卡 `Metric`——前者被模型 / 预算 / 用量三个 Tab 的筛选条共用，
 * 后者被概览与用量两个面板共用；两者都没出本屏，故仍落这里（§4.1「归属由消费者集合决定」）。
 */
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Button } from "@fenix/ui-components/ui/button";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

/**
 * 原生表单控件的类串：本页的筛选条刻意用原生 `input` / `select`（保留原生下拉与日期选择），
 * 同一种形状此前在三个 Tab 里逐处手抄（`h-8` 那份 6 处、`h-9` 与只读回显各 2 处）。
 */
export const FILTER_FIELD_CLASS = "h-8 rounded-md border bg-background px-2 text-sm";
export const DIALOG_FIELD_CLASS = "h-9 rounded-md border bg-background px-3 text-sm";
export const READONLY_FIELD_CLASS = "h-8 w-28 rounded-md border bg-muted px-2 text-sm";

/** 表格外层容器：三张表逐字共用（预算表的 `table` 骨架不同，仍复用本常量）。 */
export const GATEWAY_TABLE_SHELL_CLASS = "overflow-x-auto rounded-md border";

/** 卡片内整块加载提示的排布：`Spinner` 自带环与文案，这里只补外边距。 */
export const GATEWAY_LOADING_CLASS = "flex py-8";

/**
 * 密钥表与模型表共用的骨架。
 *
 * 列定义与行内容都由调用方给：两张表的列数、列宽、行结构都不同，能共享的只有外壳——
 * 而外壳正是此前被抄了两遍的部分（任何一侧改容器圆角/表头底色都要改两处）。
 */
export function ModelGatewayTable({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className={GATEWAY_TABLE_SHELL_CLASS}>
      <table className="w-full text-left text-sm">
        <thead className="bg-muted/40">
          <tr>{head}</tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </div>
  );
}

/** 表内「筛选后没有匹配」占位行：两处逐字相同，只有列数不同。 */
export function ModelGatewayEmptyRow({ colSpan, title }: { colSpan: number; title: string }) {
  return (
    <tr>
      {/* 纵向留白由 `EmptyState` 自己的 `py-8` 给，单元格只保留横向内边距（与原有取值一致）。 */}
      <td className="px-3" colSpan={colSpan}>
        <EmptyState title={title} className="py-8" />
      </td>
    </tr>
  );
}

/**
 * 卡片头部的刷新按钮。
 *
 * `loading` 只驱动图标转圈；`disabled` 默认跟随 `loading`，留出覆盖口——模型页的「检查」
 * 在同步请求进行中也要禁用（`busy = checking || syncing`），此时按钮转圈与否与禁用无关。
 */
export function GatewayRefreshButton({
  loading,
  disabled,
  onClick,
  children,
}: {
  loading: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button variant="outline" size="sm" disabled={disabled ?? loading} onClick={onClick}>
      <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
      {children}
    </Button>
  );
}

/**
 * 指标卡：标签 + 主数值 +（可选）脚注，概览与用量两个 Tab 的指标区共用。
 *
 * 只收口外形，不收口取数与格式：主数值一律由调用方算好（金额经 `formatUsd`、计数经
 * `formatCompactNumber`），因为两侧的「没有数据时显示什么」并不相同（概览是加载中 / `—`，用量是直接不出卡）。
 */
export function Metric({ label, value, foot }: { label: string; value: string | number; foot?: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      {foot && <p className="mt-1 text-xs text-text-muted">{foot}</p>}
    </div>
  );
}
