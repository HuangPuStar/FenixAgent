import type { AdmissionController } from "../capacity/admission";
import type { Clock, DigestFn, RandomSource } from "../clock";
import type { ProjectionStore } from "../store/types";
import type { SyncRuntimeConfigOverrides } from "./config";
import type { SyncFrameTransport } from "./egress";
import type { SyncHistorySource, SyncHostRuntimeConfig, SyncHostScope } from "./host-session";
import type { SyncStoreRegistry } from "./store-registry";

/** 宿主连接的已授权依赖与可选基础设施注入；预算与存储必须使用相同的额度owner。 */
export interface SyncHostSessionOptions {
  readonly scope: SyncHostScope;
  readonly runtimeConfig: SyncHostRuntimeConfig;
  readonly transport: SyncFrameTransport;
  readonly clock?: Clock;
  readonly digest?: DigestFn;
  readonly random?: RandomSource;
  readonly overrides?: Omit<SyncRuntimeConfigOverrides, "lifecycle" | "spoolRootDir">;
  /** 存储替身（测试或未来 DB adapter）；缺省为独立内存 store。 */
  readonly store?: ProjectionStore;
  /** 注入带预算的Store时必须共用同一Controller；缺省由scope runtime创建。 */
  readonly admission?: AdmissionController;
  /**
   * 同 scope 共享投影存储：多标签页必须看到同一份已提交事实。
   * 只共享 store 与一次历史引导；每个连接仍独立持有 runtime/provider，竞争失败按 follower 降级。
   */
  readonly storeRegistry?: SyncStoreRegistry;
  /** 稳定历史源；缺省或读取为空时回退空基线。读取失败不缓存，下一次连接可重试。 */
  readonly historySource?: SyncHistorySource;
  /** 同 scope 投影换代必须换 store binding，避免复用旧时间线和历史引导。 */
  readonly storeBinding?: string;
  readonly owner?: string;
  readonly onError?: (message: string, error: unknown) => void;
  /** 入口永久停写：宿主据此让客户端重建投影。 */
  readonly onIngressStopped?: (error: unknown) => void;
}
