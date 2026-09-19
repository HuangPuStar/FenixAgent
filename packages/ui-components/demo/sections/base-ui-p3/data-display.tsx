import {
  Button,
  Card,
  CardContent,
  CardHeader,
  ChartContainer,
  EmptyState,
  Pagination,
  Progress,
  Skeleton,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tree,
  type TreeNodeData,
} from "@fenix/ui-components";
import { Inbox, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Tooltip as ChartTooltip, Line, LineChart, XAxis, YAxis } from "recharts";

import { ComponentBlock, Example } from "./shared";

/**
 * Base UI P3 · 数据展示：Table（loading / empty / ready / error）/ Tree / Pagination / Chart /
 * Skeleton / Progress。
 *
 * 这些组件的共同点是「只渲染给定的数据，不产生交互契约」：分页与树的时序状态、文案函数
 * 一律由调用方注入，本文件里的状态只用于驱动演示。
 *
 * 两处取法由组件契约决定，不是随意简化：
 * - Pagination 的文案由调用方注入 `t`（translationPrefix 只是键前缀），demo 没有对应文案键，示例自备最小实现；
 * - 树节点加载函数必须放在模块作用域，见 TREE_CHILDREN 上方的说明。
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

/** 数据展示示例组。 */
export function DataDisplayExamples() {
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [viewState, setViewState] = useState<ViewState>("ready");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // 分页示例只用序号占位，重点是控件本身的交互；pageSize 会被 Pagination 限制在 20 / 50 / 100。
  const totalRows = 63;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const firstRow = (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, totalRows);

  return (
    <>
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

      <ComponentBlock name="Skeleton" description="加载占位块；尺寸完全由 className 决定，组件本身不含业务语义。">
        <Example title="Text lines" description="用不等宽的三行模拟段落，避免加载完成时布局跳动。">
          <div className="flex w-full max-w-sm flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </Example>
        <Example title="Media object" description="圆形头像 + 文本行的经典组合，圆角由 rounded-full 覆盖。">
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        </Example>
        <Example
          title="Empty card"
          description="边界：卡片数据到达前的空态占位，结构必须与真实卡片一致才有防跳动效果。"
        >
          <Card className="w-full max-w-sm">
            <CardHeader>
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-3 w-40" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-16 w-full" />
            </CardContent>
          </Card>
        </Example>
      </ComponentBlock>

      <div className="demo-example">
        <h2 className="demo-example-title">Progress</h2>
        <div className="demo-field">
          <p className="demo-hint">Progress 只表达确定进度（0-100）；不确定耗时的加载态用按钮或弹窗的 loading。</p>
          <div className="demo-column">
            <div className="demo-field">
              <div className="demo-row">
                <span className="text-sm">Uploading files</span>
                <span className="text-sm text-muted-foreground">70%</span>
              </div>
              <Progress value={70} />
            </div>
            <div className="demo-field">
              <div className="demo-row">
                <span className="text-sm">Indexing documents</span>
                <span className="text-sm text-muted-foreground">35%</span>
              </div>
              <Progress value={35} />
            </div>
          </div>
        </div>
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
    </>
  );
}
