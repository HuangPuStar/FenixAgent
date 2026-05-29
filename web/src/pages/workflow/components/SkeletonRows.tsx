export function SkeletonRow({ cols }: { cols: string }) {
  return (
    <div className="grid gap-2 px-4 py-3 border-b border-border-subtle animate-pulse" style={{ gridTemplateColumns: cols }}>
      {Array.from({ length: cols.split(/\s+/).length }).map((_, i) => (
        <div key={i} className="h-3 bg-surface-2 rounded" />
      ))}
    </div>
  );
}

export function SkeletonTable({ cols, rows = 5 }: { cols: string; rows?: number }) {
  return (
    <div className="border border-border-subtle rounded-lg overflow-hidden bg-surface-1">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} cols={cols} />
      ))}
    </div>
  );
}

export function SkeletonVersionRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="border border-border-subtle rounded-lg overflow-hidden bg-surface-1">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle animate-pulse">
          <div className="h-4 w-10 bg-surface-2 rounded" />
          <div className="h-3 w-20 bg-surface-2 rounded" />
          <div className="ml-auto h-3 w-16 bg-surface-2 rounded" />
        </div>
      ))}
    </div>
  );
}
