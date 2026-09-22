/**
 * 近期热度（recency heat）的查表口径与两个消费点 —— 记忆表格视图与实体视图此前各写一份。
 *
 * 两个视图的**数据来源不同**（表格行按 `recencyBasis` 取时间、实体图取每条共现边上的最近一次共现），
 * 但**归一化与图例口径必须一致**：同一个节点不该在两个视图里显示成两种冷热度，图例两端的日期也必须
 * 取同一份范围。逐字相同的归一化此前散在两处，改一处忘另一处就会让两个视图的同一个节点颜色不一致。
 */
export interface RecencyLookup {
  /** 节点 id → 时间戳。 */
  times: Map<string, number>;
  /** 参与归一化的时间范围（两端的节点分别最冷 / 最热）。 */
  minT: number;
  maxT: number;
}

/** 热度归一化：查不到的节点按最冷（0）算；整图没有可用时间范围时不着色（0.5）。 */
export function recencyHeat(lookup: RecencyLookup | null, nodeId: string): number {
  if (!lookup) return 0.5;
  const ts = lookup.times.get(nodeId);
  if (ts === undefined) return 0;
  return (ts - lookup.minT) / (lookup.maxT - lookup.minT);
}

/** 热力图例两端的日期（ISO 日期串）；没有可用范围时不传图例。 */
export function recencyEndpoints(lookup: RecencyLookup | null): [string, string] | undefined {
  if (!lookup) return;
  return [new Date(lookup.minT).toISOString().slice(0, 10), new Date(lookup.maxT).toISOString().slice(0, 10)];
}
