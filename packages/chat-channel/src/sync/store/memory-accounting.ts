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
  private readonly charges = new Map<K, Reservation[]>();
  constructor(
    protected readonly budget: MemoryBudget | undefined,
    private readonly estimate: (key: K, value: V) => Partial<Record<ServerPoolName, number>>,
  ) {
    super();
  }
  prepare(key: K, value: V): PreparedSet {
    return this.prepareValue(key, value, false);
  }
  /** 仅供数组追加使用：旧值的所有对象、缓冲与计费归属都继续保留。 */
  protected prepareRetaining(key: K, value: V): PreparedSet {
    return this.prepareValue(key, value, true);
  }
  private prepareValue(key: K, value: V, retain: boolean): PreparedSet {
    const reservations: Reservation[] = [];
    const oldCharges = this.charges.get(key) ?? [];
    const oldEstimate: Partial<Record<ServerPoolName, number>> =
      retain && this.has(key) ? this.estimate(key, this.get(key)!) : {};
    const nextEstimate = this.estimate(key, value);
    for (const [pool, bytes] of Object.entries(oldEstimate))
      if ((nextEstimate[pool as ServerPoolName] ?? 0) < bytes)
        throw new RangeError("retained accounting cannot shrink an existing pool");
    try {
      if (this.budget)
        for (const [pool, bytes] of Object.entries(nextEstimate)) {
          const retained = oldEstimate[pool as ServerPoolName] ?? 0;
          if (bytes > retained) reservations.push(this.budget.reserve(pool as ServerPoolName, bytes - retained));
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
        if (!retain) this.release(key);
        super.set(key, value);
        if (retain) {
          oldCharges.push(...reservations);
          this.charges.set(key, oldCharges);
        } else this.charges.set(key, reservations);
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

/** 仅追加原样共享的旧数组元素；替换元素、缓冲或缩小数组仍须使用完整 prepare。 */
export class AccountedArrayMap<K, T> extends AccountedMap<K, T[]> {
  /** 旧前缀原样共享；失败只归还新增与临时额度，旧值和计费保持不变。 */
  prepareAppend(key: K, additions: readonly T[]): PreparedSet {
    const previous = this.get(key) ?? [];
    const temporary = this.budget?.reserve("controlIndex", 128 + previous.length * 8);
    try {
      // 临时数组先取得额度；旧记录对象和 bytes 不复制，也不重复取得其存量额度。
      const value = [...previous, ...additions];
      const prepared = this.prepareRetaining(key, value);
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
