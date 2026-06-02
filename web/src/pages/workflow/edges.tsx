import { BaseEdge, type EdgeProps, getBezierPath } from "@xyflow/react";

/** 逻辑关系边 — 实线或虚线贝塞尔曲线 */
export function LogicEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const hasCondition = (data as Record<string, unknown>)?.hasCondition === true;

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        ...style,
        stroke: style?.stroke ?? "#94a3b8",
        strokeWidth: style?.strokeWidth ?? 1.5,
        strokeDasharray: hasCondition ? "6 3" : undefined,
      }}
    />
  );
}

/** 参数指引边 — 更细的点线曲线 */
export function DataFlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        stroke: "#10b981",
        strokeWidth: 1,
        strokeDasharray: "2 3",
      }}
    />
  );
}

export const edgeTypes = {
  logic: LogicEdge,
  dataFlow: DataFlowEdge,
};
