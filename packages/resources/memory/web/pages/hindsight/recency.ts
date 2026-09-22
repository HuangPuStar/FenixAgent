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

/**
 * 查表收口：两个视图各自扫完数据后，都用这一处判断「有没有可用的时间范围」。
 *
 * 没有可用范围（一条时间都没取到，或全部落在同一个时间点）时必须返回 `null` 而不是一个
 * `maxT === minT` 的查表——否则 `recencyHeat` 会拿它算出 `0/0 = NaN`，节点颜色退化成
 * 「既不是冷也不是热」的未定义态。这条口径此前在表格视图与实体视图里逐字各写一份。
 */
export function toRecencyLookup(times: Map<string, number>, minT: number, maxT: number): RecencyLookup | null {
  if (!Number.isFinite(minT) || !Number.isFinite(maxT) || maxT === minT) return null;
  return { times, minT, maxT };
}

/** 热力图例两端的日期（ISO 日期串）；没有可用范围时不传图例。 */
export function recencyEndpoints(lookup: RecencyLookup | null): [string, string] | undefined {
  if (!lookup) return;
  return [new Date(lookup.minT).toISOString().slice(0, 10), new Date(lookup.maxT).toISOString().slice(0, 10)];
}
