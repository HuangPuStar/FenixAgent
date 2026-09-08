import type { InstanceSupplement } from "../types/store";

/**
 * InstanceRegistry — 简化版内存注册表
 *
 * 封装 core RuntimeFacade 不维护的 RCS 业务元数据（supplements）
 * 和环境级实例计数器。
 *
 * 设计决策：
 * - 复用 InstanceSupplement 类型，不引入新类型
 * - 保留单调计数器（envCounters），不从现有实例推导
 * - byEnvironment 索引用于高效按环境查询
 * - reconcile() 方法用于与 CoreRuntimeFacade 对账
 * - 纯内存存储，不解决重启问题
 */
export class InstanceRegistry {
  /** 空闲回收关闭码，前端识别此码后跳过自动重连。 */
  static readonly IDLE_RECLAIM_CLOSE_CODE = 4001;

  private supplements = new Map<string, InstanceSupplement>();
  private byEnvironment = new Map<string, Set<string>>();

  /** 注册实例补充信息 */
  register(instanceId: string, supplement: InstanceSupplement): void {
    this.supplements.set(instanceId, supplement);
    let set = this.byEnvironment.get(supplement.environmentId);
    if (!set) {
      set = new Set();
      this.byEnvironment.set(supplement.environmentId, set);
    }
    set.add(instanceId);
  }

  /** 注销实例补充信息，同时清理 byEnvironment 索引 */
  unregister(instanceId: string): void {
    const sup = this.supplements.get(instanceId);
    if (!sup) return;
    this.supplements.delete(instanceId);
    const set = this.byEnvironment.get(sup.environmentId);
    if (set) {
      set.delete(instanceId);
      if (set.size === 0) this.byEnvironment.delete(sup.environmentId);
    }
  }

  /** 注销实例补充信息。 */
  unregisterAndDeleteCounter(instanceId: string): void {
    this.unregister(instanceId);
  }

  /** 获取实例补充信息 */
  get(instanceId: string): InstanceSupplement | undefined {
    return this.supplements.get(instanceId);
  }

  /** 更新实例最近一次业务活跃时间，并在重新活跃时清空空闲观察起点。 */
  touchActivity(instanceId: string, at = Date.now()): void {
    const supplement = this.supplements.get(instanceId);
    if (!supplement) return;
    supplement.lastActivityAt = at;
    if (supplement.relayCount > 0) {
      supplement.lastRelayDetachedAt = null;
    }
  }

  /** 记录 relay 连接附着，实例重新进入前台使用状态。 */
  attachRelay(instanceId: string, at = Date.now()): void {
    const supplement = this.supplements.get(instanceId);
    if (!supplement) return;
    supplement.relayCount += 1;
    supplement.lastActivityAt = at;
    supplement.lastRelayDetachedAt = null;
  }

  /** 记录 relay 连接分离；当计数归零时开始空闲观察窗口。 */
  detachRelay(instanceId: string, at = Date.now()): void {
    const supplement = this.supplements.get(instanceId);
    if (!supplement) return;
    supplement.relayCount = Math.max(0, supplement.relayCount - 1);
    if (supplement.relayCount === 0) {
      supplement.lastRelayDetachedAt = at;
    }
  }

  /** 检查实例是否已注册 */
  has(instanceId: string): boolean {
    return this.supplements.has(instanceId);
  }

  /** 按环境 ID 获取所有实例的 [instanceId, supplement] 对 */
  getByEnvironment(environmentId: string): Array<[string, InstanceSupplement]> {
    const ids = this.byEnvironment.get(environmentId);
    if (!ids) return [];
    return [...ids].map((id) => [id, this.supplements.get(id)!] as [string, InstanceSupplement]).filter(([, s]) => s);
  }

  /** 清空所有注册信息和索引 */
  clear(): void {
    this.supplements.clear();
    this.byEnvironment.clear();
  }

  /** 返回所有注册条目的迭代器 */
  entries(): IterableIterator<[string, InstanceSupplement]> {
    return this.supplements.entries();
  }

  /** 已注册实例总数 */
  get size(): number {
    return this.supplements.size;
  }

  /**
   * 与 CoreRuntimeFacade 对账。
   * 移除 registry 中存在但 core 中不存在的条目（孤儿条目）。
   */
  reconcile(listCoreInstances: () => Array<{ instanceId: string }>): void {
    const coreIds = new Set(listCoreInstances().map((i) => i.instanceId));
    // 收集需要移除的 ID，避免迭代中修改 Map
    const orphaned: string[] = [];
    for (const [id] of this.supplements) {
      if (!coreIds.has(id)) {
        orphaned.push(id);
      }
    }
    for (const id of orphaned) {
      this.unregister(id);
    }
  }
}

/** 全局单例 */
export const globalInstanceRegistry = new InstanceRegistry();
