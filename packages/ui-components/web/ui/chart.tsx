import type { ReactElement } from "react";
import { ResponsiveContainer } from "recharts";

/** 为 Recharts 图表提供与父容器同步的响应式绘图区。 */
export function ChartContainer({ children }: { children: ReactElement }) {
  return (
    <ResponsiveContainer height="100%" width="100%">
      {children}
    </ResponsiveContainer>
  );
}
