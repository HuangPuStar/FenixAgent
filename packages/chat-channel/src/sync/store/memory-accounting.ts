import type { Reservation, ServerPoolName } from "../capacity/admission";

/** 内存 adapter 与源索引共用的进程预算端口。 */
export interface MemoryBudget {
  reserve(pool: ServerPoolName, bytes: number): Reservation;
}
/** Map 元数据按 UTF-16 和节点放大保守计费，不能只计算编码快照。 */
export function indexBytes(value: unknown): number {
  return 128 + JSON.stringify(value).length * 4;
}
interface PreparedSet {
  commit(): void;
  abort(): void;
}
/** 预留成功后才替换；可先为整批准备再原子提交，防止部分写入。 */
export class AccountedMap<K, V> extends Map<K, V> {
  private readonly charges = new Map<K, readonly Reservation[]>();
  constructor(
    private readonly budget: MemoryBudget | undefined,
    private readonly estimate: (key: K, value: V) => Partial<Record<ServerPoolName, number>>,
  ) {
    super();
  }
  prepare(key: K, value: V): PreparedSet {
    const reservations: Reservation[] = [];
    try {
      if (this.budget)
        for (const [pool, bytes] of Object.entries(this.estimate(key, value)))
          if (bytes > 0) reservations.push(this.budget.reserve(pool as ServerPoolName, bytes));
    } catch (error) {
      for (const charge of reservations) charge.release();
      throw error;
    }
    let settled = false;
    return {
      commit: () => {
        if (settled) return;
        settled = true;
        this.release(key);
        super.set(key, value);
        this.charges.set(key, reservations);
      },
      abort() {
        if (settled) return;
        settled = true;
        for (const charge of reservations) charge.release();
      },
    };
  }
  override set(key: K, value: V): this {
    this.prepare(key, value).commit();
    return this;
  }
  override delete(key: K): boolean {
    this.release(key);
    return super.delete(key);
  }
  override clear(): void {
    for (const key of this.keys()) this.release(key);
    super.clear();
  }
  private release(key: K): void {
    for (const charge of this.charges.get(key) ?? []) charge.release();
    this.charges.delete(key);
  }
}
/** 一次同步提交中的所有 Map 更新先取得额度；失败时不改变任何索引。 */
export function commitAccountedSets(prepare: (pending: PreparedSet[]) => void): void {
  const pending: PreparedSet[] = [];
  try {
    prepare(pending);
    for (const change of pending) change.commit();
  } catch (error) {
    for (const change of pending) change.abort();
    throw error;
  }
}
