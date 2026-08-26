export function Sparkline({ values, tone = "blue" }: { values: number[]; tone?: "blue" | "green" | "amber" }) {
  const width = 120;
  const height = 34;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - ((value - min) / Math.max(1, max - min)) * (height - 6) - 3;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg className={`sparkline sparkline--${tone}`} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}
