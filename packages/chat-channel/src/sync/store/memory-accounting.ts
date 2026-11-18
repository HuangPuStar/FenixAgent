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
type PoolBytes = Partial<Record<ServerPoolName, number>>;
interface AccountingEntry {
  totals: PoolBytes;
  reservations: Reservation[];
}
/** 预留成功后才替换；可先为整批准备再原子提交，防止部分写入。 */
export class AccountedMap<K, V> extends Map<K, V> {
  private readonly accounting = new Map<K, AccountingEntry>();
  private readonly pendingKeys = new Set<K>();
  constructor(
    protected readonly budget: MemoryBudget | undefined,
    private readonly estimate: (key: K, value: V) => PoolBytes,
  ) {
    super();
  }
  /** 完整替换先预留全部新值，提交后才归还旧值的额度。 */
  prepare(key: K, value: V): PreparedSet {
    return this.prepareExclusive(key, () =>
      this.prepareValue(key, value, this.budget ? this.estimate(key, value) : {}, new Set()),
    );
  }
  /** 指定池的旧分配必须原样共享；仅预留其增量，其余池仍先取得完整替换额度。 */
  prepareSharing(key: K, value: V, pools: readonly ServerPoolName[]): PreparedSet {
    return this.prepareExclusive(key, () => {
      const estimate = this.budget ? this.estimate(key, value) : {};
      for (const pool of pools) estimate[pool] = (estimate[pool] ?? 0) - (this.accounting.get(key)?.totals[pool] ?? 0);
      return this.prepareValue(key, value, estimate, new Set(pools));
    });
  }
  /** 无预算时不做估算；有预算时返回已提交值的累计池用量。 */
  accountedBytes(key: K, pool: ServerPoolName): number | undefined {
    return this.budget ? (this.accounting.get(key)?.totals[pool] ?? 0) : undefined;
  }
  /** 仅供数组追加使用：旧值的所有对象、缓冲与计费归属都继续保留。 */
  protected prepareRetaining(key: K, value: V, additions: PoolBytes): PreparedSet {
    return this.prepareValue(key, value, additions, true);
  }
  /** 估算与预留也可能同步重入；同键只能持有一份写前像，结算或准备失败后再开放。 */
  protected prepareExclusive(key: K, prepare: () => PreparedSet): PreparedSet {
    if (this.pendingKeys.has(key)) throw new Error("accounted map key already has a pending preparation");
    this.pendingKeys.add(key);
    try {
      const change = prepare();
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        try {
          action();
        } finally {
          this.pendingKeys.delete(key);
        }
      };
      return { commit: () => settle(change.commit), abort: () => settle(change.abort) };
    } catch (error) {
      this.pendingKeys.delete(key);
      throw error;
    }
  }
  private prepareValue(key: K, value: V, estimate: PoolBytes, retain: true | ReadonlySet<ServerPoolName>): PreparedSet {
    const reservations: Reservation[] = [];
    const old = this.accounting.get(key);
    const totals: PoolBytes = retain === true ? { ...old?.totals } : {};
    if (retain !== true) for (const pool of retain) totals[pool] = old?.totals[pool] ?? 0;
    try {
      if (this.budget)
        for (const [name, bytes] of Object.entries(estimate)) {
          const pool = name as ServerPoolName;
          if (bytes < 0) throw new RangeError("retained accounting cannot shrink an existing pool");
          if (bytes > 0) reservations.push(this.budget.reserve(pool, bytes));
          totals[pool] = (totals[pool] ?? 0) + bytes;
        }
    } catch (error) {
      for (const charge of reservations) charge.release();
      throw error;
    }
    let settled = false;
    return {
      commit: () => {
        if (settled) return;
        settled = true;
        if (retain !== true)
          for (const charge of old?.reservations ?? []) if (!retain.has(charge.pool)) charge.release();
        super.set(key, value);
        if (this.budget) {
          const charges =
            retain === true
              ? (old?.reservations ?? [])
              : (old?.reservations.filter((charge) => retain.has(charge.pool)) ?? []);
          charges.push(...reservations);
          this.accounting.set(key, { totals, reservations: charges });
        }
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
    if (this.pendingKeys.has(key)) throw new Error("accounted map key has a pending preparation");
    this.release(key);
    return super.delete(key);
  }
  override clear(): void {
    if (this.pendingKeys.size > 0) throw new Error("accounted map has pending preparations");
    for (const key of this.keys()) this.release(key);
    super.clear();
  }
  private release(key: K): void {
    for (const charge of this.accounting.get(key)?.reservations ?? []) charge.release();
    this.accounting.delete(key);
  }
}

/** 估算须由固定基数与逐项用量组成；仅追加原样共享的元素，替换或缩小仍须完整 prepare。 */
export class AccountedArrayMap<K, T> extends AccountedMap<K, T[]> {
  constructor(
    budget: MemoryBudget | undefined,
    private readonly estimateArray: (key: K, value: readonly T[]) => PoolBytes,
  ) {
    super(budget, estimateArray);
  }
  /** 旧前缀原样共享；失败只归还新增与临时额度，旧值和计费保持不变。 */
  prepareAppend(key: K, additions: readonly T[]): PreparedSet {
    return this.prepareExclusive(key, () => {
      const previous = this.get(key) ?? [];
      const temporary = this.budget?.reserve("controlIndex", 128 + previous.length * 8);
      try {
        const additionsEstimate = this.budget ? this.estimateArray(key, additions) : {};
        if (this.budget && this.has(key)) {
          // 空账本给出每 key 的固定基数；后续追加只为新增记录计费。
          for (const [name, bytes] of Object.entries(this.estimateArray(key, []))) {
            const pool = name as ServerPoolName;
            additionsEstimate[pool] = (additionsEstimate[pool] ?? 0) - bytes;
          }
        }
        // 临时数组先取得额度；旧记录对象和 bytes 不复制，也不重复取得其存量额度。
        const value = [...previous, ...additions];
        const prepared = this.prepareRetaining(key, value, additionsEstimate);
        return {
          commit() {
            prepared.commit();
            temporary?.release();
          },
          abort() {
            prepared.abort();
            temporary?.release();
          },
        };
      } catch (error) {
        temporary?.release();
        throw error;
      }
    });
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
