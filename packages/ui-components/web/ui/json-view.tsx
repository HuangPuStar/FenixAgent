/**
 * JsonViewer —— 自实现的递归 JSON 查看器（对象 / 数组可逐级折叠，标量按类型着色）。
 *
 * 来源与迁移：trace 包 `web/components/detail/json-view.tsx`（2026-10-10 下沉）→ 本模块。trace 侧是
 * langfuse-lite `components/json-viewer.tsx` 的移植，那里用第三方 `react18-json-view`；本实现**不引第三方
 * 依赖**，用项目自身能力重写同一个对外形态 `JsonViewer({ data, className, collapsed })`
 * （`collapsed` 语义与参考实现一致：深度 ≥ collapsed 的容器默认折叠，默认 2，即展开前两层）。
 * 下沉理由：任何需要「看原始 JSON」的位置（观测详情、工具元数据、配置回看）都该用同一份折叠 / 截断 /
 * 防循环语义，而不是各自写一份 `JSON.stringify` 预览。
 *
 * 三条硬要求：
 * 1. 对象与数组可逐级折叠；空容器渲染 `{}` / `[]`，不留可点击的假箭头。
 * 2. 长字符串先截断、可展开看全文；非对象值走各自的着色分支。
 * 3. 循环引用与病态深嵌套都有稳定文本，不抛错也不无限递归——循环判定按**路径**记录祖先，而不是全局去重：
 *    全局 WeakSet 会把它只出现一次但被两处引用的合法子树（DAG）误报成循环，而 JSON 里这种结构并不罕见。
 *    终止性由路径判定 + MAX_DEPTH 双保险保证。
 *
 * 渲染成本也是约束：数据里的数组可能是上万条目，逐条挂载会拖死面板，因此单个容器最多渲染 MAX_ENTRIES 条，
 * 其余折叠成一行计数（用户仍能看到真实规模并展开外层再看）。
 *
 * 文案取包内 `UI_COMPONENTS_NS` 的 `jsonViewer.*`（键的最终所在地 = 包的 owner）；不额外接受 labels prop，
 * 否则每个调用点都要自己接一次 i18n。
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../i18n/namespace";
import { cn } from "../lib/cn";

/** 深度 ≥ 该值的容器默认折叠（参考实现的 `collapsed = 2`）。 */
const DEFAULT_COLLAPSED_DEPTH = 2;
/** 结构性深度上限：JSON 是外部数据，病态深嵌套会把递归渲染栈打穿。 */
const MAX_DEPTH = 32;
/** 单容器渲染条目上限：超出部分只显示计数。 */
const MAX_ENTRIES = 200;
/** 字符串预览长度：超过先截断，可展开看全文。 */
const STRING_PREVIEW_CHARS = 300;

export interface JsonViewerProps {
  data: unknown;
  className?: string;
  /** 深度 ≥ collapsed 的容器默认折叠；默认 2（展开前两层）。 */
  collapsed?: number;
}

export function JsonViewer({ data, className, collapsed = DEFAULT_COLLAPSED_DEPTH }: JsonViewerProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);

  if (data === null || data === undefined) {
    return (
      <div
        className={cn("rounded-md border border-border-subtle bg-surface-2/60 p-3 text-xs text-text-muted", className)}
      >
        {t("jsonViewer.empty")}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "min-w-0 rounded-md border border-border-subtle bg-surface-2/60 p-3 font-mono text-xs leading-relaxed break-words",
        className,
      )}
    >
      <JsonNode value={data} depth={0} collapsedDepth={collapsed} ancestors={[]} />
    </div>
  );
}

/** 当前递归路径上的祖先容器（用于识别真正的循环引用）。 */
type Ancestors = readonly object[];

/** 任一 JSON 值：容器交给 ContainerNode，其余交给 Primitive。 */
function JsonNode({
  value,
  depth,
  collapsedDepth,
  ancestors,
}: {
  value: unknown;
  depth: number;
  collapsedDepth: number;
  ancestors: Ancestors;
}) {
  const { t } = useTranslation(UI_COMPONENTS_NS);

  if (typeof value !== "object" || value === null) {
    return <Primitive value={value} />;
  }
  if (ancestors.includes(value)) {
    return <span className="text-status-warning italic">{t("jsonViewer.circular")}</span>;
  }
  if (depth >= MAX_DEPTH) {
    return <span className="text-text-muted italic">{t("jsonViewer.tooDeep")}</span>;
  }

  const isArray = Array.isArray(value);
  const entries: [string, unknown][] = isArray
    ? (value as unknown[]).map((item, index) => [String(index), item])
    : Object.entries(value as Record<string, unknown>);

  if (entries.length === 0) {
    return <span className="text-text-muted">{isArray ? "[]" : "{}"}</span>;
  }

  return (
    <ContainerNode
      value={value}
      entries={entries}
      isArray={isArray}
      depth={depth}
      collapsedDepth={collapsedDepth}
      ancestors={ancestors}
    />
  );
}

/** 可折叠容器：折叠态显示 `{n}` / `[n]` 计数，展开态逐条渲染子节点。 */
function ContainerNode({
  value,
  entries,
  isArray,
  depth,
  collapsedDepth,
  ancestors,
}: {
  value: object;
  entries: [string, unknown][];
  isArray: boolean;
  depth: number;
  collapsedDepth: number;
  ancestors: Ancestors;
}) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [open, setOpen] = useState(depth < collapsedDepth);
  const childAncestors = useMemo<Ancestors>(() => [...ancestors, value], [ancestors, value]);
  const visible = open ? entries.slice(0, MAX_ENTRIES) : [];
  const hidden = entries.length - visible.length;

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        className="inline-flex items-center gap-0.5 rounded align-middle text-text-muted hover:bg-surface-hover hover:text-text-secondary"
      >
        {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        <span>{isArray ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </button>
      {open && (
        <div className="ml-2 border-l border-border-subtle pl-2">
          {visible.map(([key, child]) => (
            <div key={key} className="min-w-0">
              <span className="text-brand">{`${key}: `}</span>
              <JsonNode value={child} depth={depth + 1} collapsedDepth={collapsedDepth} ancestors={childAncestors} />
            </div>
          ))}
          {hidden > 0 && <div className="text-text-muted">{t("jsonViewer.moreEntries", { count: hidden })}</div>}
        </div>
      )}
    </div>
  );
}

/** 标量叶子：字符串 / 数字 / 布尔 / null 各用一套颜色区分。 */
function Primitive({ value }: { value: unknown }) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [expanded, setExpanded] = useState(false);

  if (typeof value === "string") {
    const needsTruncation = value.length > STRING_PREVIEW_CHARS;
    const text = needsTruncation && !expanded ? `${value.slice(0, STRING_PREVIEW_CHARS)}…` : value;
    return (
      <span className="break-words text-emerald-600 dark:text-emerald-400">
        {`"${text}"`}
        {needsTruncation && (
          <button
            type="button"
            onClick={() => setExpanded((previous) => !previous)}
            className="ms-1 text-3xs text-text-muted underline-offset-2 hover:underline"
          >
            {expanded ? t("jsonViewer.showLess") : t("jsonViewer.showMore")}
          </button>
        )}
      </span>
    );
  }
  if (typeof value === "number") {
    return <span className="text-amber-600 dark:text-amber-400">{String(value)}</span>;
  }
  if (typeof value === "boolean") {
    return <span className="text-fuchsia-600 dark:text-fuchsia-400">{String(value)}</span>;
  }
  // null 与 undefined 在 JSON 里是两种不同的缺失语义，分开显示，不合并成同一句。
  if (value === null) return <span className="text-text-muted">null</span>;
  if (value === undefined) return <span className="text-text-muted">undefined</span>;
  // 兜底：bigint / symbol 等运行时值（JSON 里不会出现，但 props 不受类型系统约束），保证渲染不抛错。
  return <span className="text-text-muted">{String(value)}</span>;
}
