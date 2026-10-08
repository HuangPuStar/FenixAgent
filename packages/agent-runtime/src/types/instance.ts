/**
 * 实例注册表（`services/instance-registry.ts`）的补充字段类型。
 *
 * 为什么归本包：`InstanceSupplement` 是 core 的 `RuntimeInstanceSnapshot` **不**追踪的 RCS 业务字段，
 * 由 `globalInstanceRegistry.register()` 写入、并发统计与空闲回收读取，注册表本身就在本包。它此前声明在宿主
 * `apps/server/src/types/store.ts`，迁移后宿主已无消费方（实测：宿主 0 处引用；workflow 的测试从
 * `Parameters<typeof globalInstanceRegistry.register>[1]` 结构推导，不 import 宿主类型）。
 */

/** 实例启动来源，用于并发分类与后续审计。 */
export type InstanceSpawnSource = "interactive" | "scheduled" | "system";

/** RCS business fields not tracked by core RuntimeInstanceSnapshot */
export interface InstanceSupplement {
  userId: string;
  environmentId: string;
  organizationId: string;
  /** 实例创建来源，用于并发分类与审计。 */
  spawnSource: InstanceSpawnSource;
  /**
   * 触发本次实例启动的关联 ID（§7）：HTTP 触发取自请求上下文，独立调度 / 机器回传入口自建。
   *
   * 实例在 core 快照与 registry 里都只有 instanceId，没有「谁触发了它」的信息；该字段让启动链路的
   * 诊断日志（含失败回滚）能回溯到触发方。可选：既有手工注册（测试、幽灵实例对账）无触发方。
   */
  requestId?: string;
  /** 最近一次非保活 ACP 业务消息时间 */
  lastActivityAt: number;
  /** 当前绑定到该实例的前端 relay 连接数 */
  relayCount: number;
  /** 最后一次 relay 全部断开、实例进入空闲观察窗口的时间 */
  lastRelayDetachedAt: number | null;
}
