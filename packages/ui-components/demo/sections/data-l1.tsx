import { Button, type Column, DataTable, StatusBadge } from "@fenix/ui-components";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * Data L1 分区：数据表格 —— 排序、分页与行选择。
 *
 * 这一层只有 DataTable 一个容器：表头、排序/过滤、展开行与分页条的结构归组件，
 * 列定义与数据由调用方注入；不传 onSelectionChange 时选中状态由组件自己持有，
 * 示例因此不需要为它准备任何 state。
 *
 * 边界是「结构与状态分支归组件，数据与回调归调用方」：示例数据全部是模块级静态假数据，
 * 不涉及任何接口调用，也没有加载/错误这类异步分支。
 *
 * 表格周边的批量操作条、状态徽标与空态在 Data L2，文件类型图标同样属于 L2；
 * 本文件只渲染自己这一层的示例。
 *
 * 导出名被 demo 外壳（demo/App.tsx）按分区装配引用，新增示例时保持导出名与签名不变。
 */

interface ComponentRow {
  id: string;
  name: string;
  status: string;
  coverage: number;
  owner: string;
}

/** 手写数据：status 取 StatusBadge 已知的取值，便于观察不同 variant；Data L2 的同名数据是各自分区独立的一份，分区文件保持自包含。 */
const ROWS: ComponentRow[] = [
  { id: "button", name: "Button", status: "enabled", coverage: 96, owner: "core" },
  { id: "data-table", name: "DataTable", status: "configured", coverage: 82, owner: "core" },
  { id: "form-dialog", name: "FormDialog", status: "unconfigured", coverage: 54, owner: "forms" },
  { id: "tree", name: "Tree", status: "enabled", coverage: 71, owner: "data" },
  { id: "chart", name: "Chart", status: "disabled", coverage: 23, owner: "data" },
  { id: "command", name: "Command", status: "custom", coverage: 66, owner: "overlay" },
];

const GET_ROW_KEY = (row: ComponentRow) => row.id;

const TABLE_COLUMNS: Column<ComponentRow>[] = [
  { key: "name", header: "Component", sortable: true, filterable: true },
  { key: "owner", header: "Owner", filterable: true },
  { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
  { key: "coverage", header: "Coverage", sortable: true, render: (row) => `${row.coverage}%` },
];

/**
 * actions / expandableRow 定义在模块作用域：DataTable 把它们放进了重建列定义的 useMemo 依赖里，
 * 每次渲染换新引用会让列定义持续重建（示例规模下不影响功能，但没有必要）。
 */
function renderRowActions(row: ComponentRow) {
  return (
    <Button size="sm" variant="outline">
      Inspect {row.name}
    </Button>
  );
}

function renderExpandedRow(row: ComponentRow) {
  return (
    <p className="text-muted-foreground text-sm">
      {row.name} · owner {row.owner} · coverage {row.coverage}%
    </p>
  );
}

export function DataL1Section() {
  const { t } = useTranslation(DEMO_NS);

  return (
    <section className="demo-section">
      <h1 className="demo-section-title">{t("sections.dataL1")}</h1>
      <p className="demo-hint">{t("sectionHints.dataL1")}</p>

      <div className="demo-example">
        <h2 className="demo-example-title">DataTable</h2>
        <DataTable
          columns={TABLE_COLUMNS}
          data={ROWS}
          searchable
          searchPlaceholder="Filter by name or owner"
          selectable
          actions={renderRowActions}
          expandableRow={renderExpandedRow}
          rowKey={GET_ROW_KEY}
          pageSize={5}
          emptyMessage="No component matches the filter"
        />
        <p className="demo-hint">
          排序、过滤、展开与分页都由 @tanstack/react-table 驱动；表头、分页条与空态文案走包内 uiComponents 命名空间。
        </p>
      </div>
    </section>
  );
}
