import {
  BatchActionBar,
  Button,
  ChartContainer,
  Checkbox,
  type Column,
  DataTable,
  EmptyState,
  FileTypeIcon,
  Pagination,
  Progress,
  Skeleton,
  StatusBadge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tree,
  type TreeNodeData,
} from "@fenix/ui-components";
import { Inbox, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Bar, BarChart, CartesianGrid, Tooltip as ChartTooltip, Line, LineChart, XAxis, YAxis } from "recharts";

import { DEMO_NS } from "../i18n";

/**
 * 数据展示分区：Table / DataTable / Tree / Pagination / Chart / StatusBadge / EmptyState / FileTypeIcon / BatchActionBar。
 * 导出名被 demo/App.tsx 引用，新增示例时保持导出名与签名不变。
 *
 * 两处示例的取法由组件契约决定，不是随意简化：
 * - DataTable 的 onSelectionChange 在它自己的 render 阶段被调用（源码里挂在 useMemo 上），接到 setState 会触发
 *   React「render 期间更新另一个组件」的告警，因此批量选择示例改用 Table + Checkbox 手写，DataTable 只演示内部选择；
 * - Pagination 的文案由调用方注入 `t`（translationPrefix 只是键前缀），demo 没有对应文案键，示例自备最小实现。
 */

interface ComponentRow {
  id: string;
  name: string;
  status: string;
  coverage: number;
  owner: string;
}

/** 手写数据：status 取 StatusBadge 已知的取值，便于观察不同 variant。 */
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

/**
 * 树节点按需加载，parentId 为 null 表示根层级。
 *
 * 必须放在模块作用域：Tree 在 getChildren 引用变化时重新加载根节点，内联箭头函数会让每次渲染都触发一次加载。
 * 真实宿主这里通常是一次请求，demo 直接返回内存数据。
 */
const TREE_CHILDREN: Record<string, TreeNodeData[]> = {
  root: [
    { id: "src", label: "src", hasChildren: true, description: "source" },
    { id: "docs", label: "docs", hasChildren: true, description: "guides" },
    { id: "readme", label: "README.md" },
  ],
  src: [
    { id: "src/ui", label: "ui", hasChildren: true },
    { id: "src/main.tsx", label: "main.tsx", badge: "tsx" },
  ],
  "src/ui": [
    { id: "src/ui/button.tsx", label: "button.tsx" },
    { id: "src/ui/table.tsx", label: "table.tsx", isDisabled: true, description: "disabled node" },
  ],
  docs: [{ id: "docs/guide.md", label: "guide.md", badge: "md" }],
};

async function loadTreeChildren(parentId: string | null): Promise<TreeNodeData[]> {
  return TREE_CHILDREN[parentId ?? "root"] ?? [];
}

const CHART_DATA = [
  { label: "Mon", renders: 128, failures: 6 },
  { label: "Tue", renders: 164, failures: 3 },
  { label: "Wed", renders: 142, failures: 9 },
  { label: "Thu", renders: 198, failures: 4 },
  { label: "Fri", renders: 176, failures: 2 },
];

/** 加载态占位行的稳定 key；用数组下标会让 lint 报警，也不必要。 */
const SKELETON_ROWS = ["row-1", "row-2", "row-3"];

type ViewState = "loading" | "ready" | "empty" | "error";

const VIEW_STATES: ViewState[] = ["loading", "ready", "empty", "error"];

/** Pagination 要求调用方注入翻译函数；demo 没有对应文案键，这里只保留可读的英文默认值。 */
function paginationT(key: string, opts?: Record<string, unknown>): string {
  if (key.endsWith("pagination_total")) return `${String(opts?.total ?? 0)} rows`;
  if (key.endsWith("pagination_page_size")) return `${String(opts?.size ?? 0)} / page`;
  return key;
}

/** 同一份数据的三种非就绪态：loading 用 Skeleton 占位，empty / error 复用 EmptyState。 */
function StatePreview({ state, onRetry }: { state: ViewState; onRetry: () => void }) {
  if (state === "loading") {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Component</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Coverage</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {SKELETON_ROWS.map((key) => (
            <TableRow key={key}>
              <TableCell>
                <Skeleton className="h-4 w-32" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-16" />
              </TableCell>
              <TableCell>
                <Skeleton className="ml-auto h-4 w-12" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  if (state === "empty") {
    return (
      <EmptyState
        icon={<Inbox className="h-8 w-8" />}
        title="No components yet"
        description="EmptyState 负责空态：图标、标题、描述与一个可选 action。"
        action={{ label: "Reload", onClick: onRetry }}
      />
    );
  }

  if (state === "error") {
    return (
      <EmptyState
        icon={<TriangleAlert className="h-8 w-8 text-destructive" />}
        title="Failed to load components"
        description="错误态同样可以落在 EmptyState 上，action 即重试入口。"
        action={{ label: "Retry", onClick: onRetry }}
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Component</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Coverage</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ROWS.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-medium">{row.name}</TableCell>
            <TableCell>
              <StatusBadge status={row.status} />
            </TableCell>
            <TableCell className="text-right">{row.coverage}%</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function DataSection() {
  const { t } = useTranslation(DEMO_NS);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [viewState, setViewState] = useState<ViewState>("ready");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // 分页示例只用序号占位，重点是控件本身的交互；pageSize 会被 Pagination 限制在 20 / 50 / 100。
  const totalRows = 63;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const firstRow = (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, totalRows);

  const toggleRow = (id: string, checked: boolean) => {
    setSelectedIds((prev) => (checked ? [...prev, id] : prev.filter((selected) => selected !== id)));
  };

  return (
    <section className="demo-section">
      <h1 className="demo-section-title">{t("sections.data")}</h1>

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

      <div className="demo-example">
        <h2 className="demo-example-title">Table：loading / empty / error</h2>
        <div className="demo-row mb-4">
          {VIEW_STATES.map((state) => (
            <Button
              key={state}
              size="sm"
              variant={viewState === state ? "default" : "outline"}
              onClick={() => setViewState(state)}
            >
              {state}
            </Button>
          ))}
        </div>
        <StatePreview state={viewState} onRetry={() => setViewState("loading")} />
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">Tree</h2>
        <Tree
          getChildren={loadTreeChildren}
          defaultExpandedIds={["src"]}
          onSelect={(nodeId) => setSelectedNode(nodeId)}
          className="w-72 rounded-md border border-border p-2"
        />
        <p className="demo-hint">selected: {selectedNode ?? "—"}（展开节点时按需调用 getChildren）</p>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">Pagination</h2>
        <Pagination
          page={page}
          totalPages={totalPages}
          total={totalRows}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          translationPrefix="demo"
          t={paginationT}
        />
        <p className="demo-hint">
          page {page} / {totalPages} · rows {firstRow}–{lastRow} · pageSize {pageSize}
        </p>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">Chart</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="h-56">
            <ChartContainer>
              <LineChart data={CHART_DATA}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" />
                <YAxis width={32} />
                <ChartTooltip />
                <Line type="monotone" dataKey="renders" stroke="var(--color-brand)" strokeWidth={2} dot={false} />
                <Line
                  type="monotone"
                  dataKey="failures"
                  stroke="var(--color-destructive)"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ChartContainer>
          </div>
          <div className="h-56">
            <ChartContainer>
              <BarChart data={CHART_DATA}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" />
                <YAxis width={32} />
                <ChartTooltip />
                <Bar dataKey="renders" fill="var(--color-brand)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartContainer>
          </div>
        </div>
        <p className="demo-hint">
          ChartContainer 只是 ResponsiveContainer 的包装，父容器必须有确定高度（示例为 h-56）；取色直接用包内 token，
          因此图表跟随主题切换。
        </p>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">StatusBadge</h2>
        <div className="demo-row">
          {["enabled", "configured", "unconfigured", "disabled", "custom", "builtIn"].map((status) => (
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
          {["report.pdf", "budget.xlsx", "notes.md", "archive.zip", "script.ts", "no-extension"].map((filename) => (
            <span key={filename} className="text-muted-foreground flex items-center gap-2 text-xs">
              <FileTypeIcon filename={filename} />
              {filename}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
