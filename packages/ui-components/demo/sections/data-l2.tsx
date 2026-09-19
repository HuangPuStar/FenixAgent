import {
  BatchActionBar,
  Checkbox,
  EmptyState,
  FileTypeIcon,
  Progress,
  StatusBadge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@fenix/ui-components";
import { Inbox, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * Data L2 分区：表格周边 —— 批量操作、空态、状态徽标与文件类型图标。
 *
 * 这一层是围绕数据集合的「周边能力」：Table 这类结构基元、跨行选择后的批量操作条、
 * 空态/错误态容器，以及表达状态与文件类型的两个徽标。
 * 边界依旧是「结构归组件，数据与选中状态归调用方」——示例的选中、重试回调都在本文件内，
 * 数据是模块级静态假数据，不涉及任何接口调用，也没有真正的异步加载流程。
 *
 * 批量操作示例用 Table + Checkbox 手写而不是复用 DataTable，是组件契约决定的取法，不是随意简化：
 * DataTable 的 onSelectionChange 在它自己的 render 阶段被调用（源码里挂在 useMemo 上），
 * 接到 setState 会触发 React「render 期间更新另一个组件」的告警，因此 DataTable 只在 Data L1 演示内部选择。
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

/** 手写数据：status 取 StatusBadge 已知的取值，便于观察不同 variant；Data L1 的同名数据是各自分区独立的一份，分区文件保持自包含。 */
const ROWS: ComponentRow[] = [
  { id: "button", name: "Button", status: "enabled", coverage: 96, owner: "core" },
  { id: "data-table", name: "DataTable", status: "configured", coverage: 82, owner: "core" },
  { id: "form-dialog", name: "FormDialog", status: "unconfigured", coverage: 54, owner: "forms" },
  { id: "tree", name: "Tree", status: "enabled", coverage: 71, owner: "data" },
  { id: "chart", name: "Chart", status: "disabled", coverage: 23, owner: "data" },
  { id: "command", name: "Command", status: "custom", coverage: 66, owner: "overlay" },
];

/** StatusBadge 的候选取值：末项故意与包内 builtin 键大小写不同，用来展示未命中时的回退。 */
const STATUS_SAMPLES = ["enabled", "configured", "unconfigured", "disabled", "custom", "builtIn"];

const FILE_TYPE_SAMPLES = ["report.pdf", "budget.xlsx", "notes.md", "archive.zip", "script.ts", "no-extension"];

export function DataL2Section() {
  const { t } = useTranslation(DEMO_NS);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /**
   * 两个 EmptyState 示例的 action 都是重试入口：源示例用它把同一份数据切回 loading 态，
   * 而那个三态表格演示属于 P3，这里没有可取数的数据源，因此回调只记录最后一次触发，保证 action 可交互。
   */
  const [lastRetry, setLastRetry] = useState<string | null>(null);

  const toggleRow = (id: string, checked: boolean) => {
    setSelectedIds((prev) => (checked ? [...prev, id] : prev.filter((selected) => selected !== id)));
  };

  const handleEmptyRetry = () => setLastRetry("Reload from empty state");

  const handleErrorRetry = () => setLastRetry("Retry from error state");

  return (
    <section className="demo-section">
      <h1 className="demo-section-title">{t("sections.dataL2")}</h1>
      <p className="demo-hint">{t("sectionHints.dataL2")}</p>

      <div className="demo-example">
        <h2 className="demo-example-title">Table + Checkbox + BatchActionBar</h2>
        <Table>
          <TableCaption>
            勾选任意行后 BatchActionBar 出现（组件自身固定在视口底部居中）；示例里点 action 等同于操作完成并清空选择。
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              <TableHead>Component</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-32">Coverage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ROWS.map((row) => (
              <TableRow key={row.id} data-state={selectedIds.includes(row.id) ? "selected" : undefined}>
                <TableCell>
                  <Checkbox
                    checked={selectedIds.includes(row.id)}
                    onCheckedChange={(checked) => {
                      toggleRow(row.id, checked === true);
                    }}
                  />
                </TableCell>
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell>
                  <StatusBadge status={row.status} />
                </TableCell>
                <TableCell>
                  <Progress value={row.coverage} className="w-24" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {selectedIds.length > 0 ? (
          <BatchActionBar
            selectedCount={selectedIds.length}
            actions={[
              { label: "Export", onClick: () => setSelectedIds([]) },
              { label: "Delete", variant: "destructive", onClick: () => setSelectedIds([]) },
            ]}
            onClear={() => setSelectedIds([])}
          />
        ) : null}
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">StatusBadge</h2>
        <div className="demo-row">
          {STATUS_SAMPLES.map((status) => (
            <StatusBadge key={status} status={status} />
          ))}
        </div>
        <p className="demo-hint">
          文案按 statusBadge.&lt;status&gt; 查表，未命中的状态回退为状态原文（如 builtIn 与包内 builtin 键大小写不同）。
        </p>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">FileTypeIcon</h2>
        <div className="demo-row">
          {FILE_TYPE_SAMPLES.map((filename) => (
            <span key={filename} className="text-muted-foreground flex items-center gap-2 text-xs">
              <FileTypeIcon filename={filename} />
              {filename}
            </span>
          ))}
        </div>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">EmptyState：No components yet</h2>
        <EmptyState
          icon={<Inbox className="h-8 w-8" />}
          title="No components yet"
          description="EmptyState 负责空态：图标、标题、描述与一个可选 action。"
          action={{ label: "Reload", onClick: handleEmptyRetry }}
        />
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">EmptyState：Failed to load components</h2>
        <EmptyState
          icon={<TriangleAlert className="h-8 w-8 text-destructive" />}
          title="Failed to load components"
          description="错误态同样可以落在 EmptyState 上，action 即重试入口。"
          action={{ label: "Retry", onClick: handleErrorRetry }}
        />
      </div>

      {lastRetry ? <p className="demo-hint">Last callback: {lastRetry}</p> : null}
    </section>
  );
}
