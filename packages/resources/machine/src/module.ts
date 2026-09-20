import {
  destroyEnvironmentQueue,
  ensure as ensureEnvironmentQueue,
  publishFileEvent,
  publishInvalidateAll,
  subscribe,
} from "./server/services/file-event-queue";
import {
  startHeartbeat,
  startMachineSweep,
  stopHeartbeat,
  stopMachineSweep,
} from "./server/services/registry-heartbeat";
import { closeAllFileWsConnections, startFileWsSweep, stopFileWsSweep } from "./server/transport/file-ws-handler";

/**
 * Machine 模块的运行时表面（`fenix.module.ts` 的 `create` 目标）。
 *
 * 只暴露需要「对象身份」的能力：本包有三处进程级可变状态——file-ws 连接索引、心跳/巡检定时器、文件变更
 * 事件队列。它们各自都要求进程内唯一：两份连接索引会让同一机器的清理路径分裂（一处 close 了、另一处仍认为
 * 在线）；两份巡检定时器会对同一批机器重复标记超时；两份事件队列会让订阅者收到重复帧。因此组合根返回的是
 * 包内既有单例的入口，不新建第二套。
 *
 * 路由工厂、`handleFileWsMessage` 等帧处理入口、`getMachineConfig()` 都是宿主显式调用的入口，不经过模块实例
 * 即可使用，故不在这里重复包装；等 registry 驱动的装配落地（§1.5 的 `mountContribution`）需要统一拿到它们时
 * 再按需扩展（与 `@fenix/resource-sandbox`、`@fenix/resource-skill` 的组合根同口径）。
 *
 * 存在的意义同时是 manifest 的惰性 `create` 工厂需要一个入口：模块索引层只 import `fenix.module.ts`，装配期再
 * 按需加载 `./server` 图。
 */
export interface MachineModule {
  readonly id: "machine";
  /** file-ws 连接索引的生命周期入口：僵尸巡检开关与优雅关闭时的全量断开。 */
  readonly fileWs: {
    readonly closeAllConnections: typeof closeAllFileWsConnections;
    readonly startSweep: typeof startFileWsSweep;
    readonly stopSweep: typeof stopFileWsSweep;
  };
  /** 心跳与在线巡检：定时器 owner，同一机器只允许有一条超时判定路径。 */
  readonly heartbeat: {
    readonly start: typeof startHeartbeat;
    readonly stop: typeof stopHeartbeat;
    readonly startSweep: typeof startMachineSweep;
    readonly stopSweep: typeof stopMachineSweep;
  };
  /** 文件变更事件总线：订阅注册表、按环境 fan-out 与限频状态 owner。 */
  readonly fileEvents: {
    readonly subscribe: typeof subscribe;
    readonly publish: typeof publishFileEvent;
    readonly publishInvalidateAll: typeof publishInvalidateAll;
    readonly ensureEnvironment: typeof ensureEnvironmentQueue;
    readonly destroyEnvironment: typeof destroyEnvironmentQueue;
  };
}

/** 创建 Machine 模块实例；返回的是包内既有单例的入口，重复调用不产生第二份运行期状态。 */
export function createMachineModule(): MachineModule {
  return {
    id: "machine",
    fileWs: {
      closeAllConnections: closeAllFileWsConnections,
      startSweep: startFileWsSweep,
      stopSweep: stopFileWsSweep,
    },
    heartbeat: {
      start: startHeartbeat,
      stop: stopHeartbeat,
      startSweep: startMachineSweep,
      stopSweep: stopMachineSweep,
    },
    fileEvents: {
      subscribe,
      publish: publishFileEvent,
      publishInvalidateAll,
      ensureEnvironment: ensureEnvironmentQueue,
      destroyEnvironment: destroyEnvironmentQueue,
    },
  };
}
