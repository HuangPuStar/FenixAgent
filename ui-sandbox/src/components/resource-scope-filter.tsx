export function ResourceScopeFilter<TScope extends string>({
  value,
  onChange,
  counts,
  options,
}: {
  value: TScope;
  onChange: (scope: TScope) => void;
  counts?: Partial<Record<TScope, number>>;
  options: readonly TScope[];
}) {
  return (
    <div className="segmented resource-scope-filter" role="group" aria-label="归属范围">
      {options.map((scope) => (
        <button
          type="button"
          className={value === scope ? "is-active" : ""}
          aria-pressed={value === scope}
          onClick={() => onChange(scope)}
          key={scope}
        >
          {scope}
          {counts?.[scope] !== undefined && <span>{counts[scope]}</span>}
        </button>
      ))}
    </div>
  );
}
