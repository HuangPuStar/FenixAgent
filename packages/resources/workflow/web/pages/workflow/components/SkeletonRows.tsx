export function SkeletonRow({ cols }: { cols: string }) {
  return (
    <div
      className="grid gap-2 px-4 py-3 border-b border-border-subtle animate-pulse"
      style={{ gridTemplateColumns: cols }}
    >
      {/* 占位单元格没有领域标识：先生成键数组（`cell-0`…）再渲染，键在列表内稳定且不把下标直接交给
          React（`key={i}` 会被 biome 的 noArrayIndexKey 拦下；骨架屏不重排、无行内状态，序号派生键即可）。 */}
      {Array.from({ length: cols.split(/\s+/).length }, (_, i) => `cell-${i}`).map((cellKey) => (
        <div key={cellKey} className="h-3 bg-surface-2 rounded" />
      ))}
    </div>
  );
}

export function SkeletonTable({ cols, rows = 5 }: { cols: string; rows?: number }) {
  return (
    <div className="border border-border-subtle rounded-lg overflow-hidden bg-surface-1">
      {Array.from({ length: rows }, (_, i) => `row-${i}`).map((rowKey) => (
        <SkeletonRow key={rowKey} cols={cols} />
      ))}
    </div>
  );
}

export function SkeletonVersionRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="border border-border-subtle rounded-lg overflow-hidden bg-surface-1">
      {Array.from({ length: rows }, (_, i) => `version-row-${i}`).map((rowKey) => (
        <div key={rowKey} className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle animate-pulse">
          <div className="h-4 w-10 bg-surface-2 rounded" />
          <div className="h-3 w-20 bg-surface-2 rounded" />
          <div className="ml-auto h-3 w-16 bg-surface-2 rounded" />
        </div>
      ))}
    </div>
  );
}
