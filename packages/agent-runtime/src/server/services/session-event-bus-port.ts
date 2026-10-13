import type { EventBus } from "../../transport/event-bus";

/** Session 生命周期所需的最小事件总线能力，由 apps/server 绑定。 */
export interface SessionEventBusPort {
  getAllBuses(): Map<string, EventBus>;
  removeBus(sessionId: string): void;
}

let sessionEventBusPort: SessionEventBusPort | null = null;

/** 绑定 Machine 资源包持有的 session 事件总线。 */
export function bindSessionEventBusPort(port: SessionEventBusPort): void {
  sessionEventBusPort = port;
}

/** 获取已绑定端口；遗漏宿主装配时明确失败，避免 runtime 反向依赖资源包。 */
export function getSessionEventBusPort(): SessionEventBusPort {
  if (!sessionEventBusPort) throw new Error("Session event-bus port has not been bound");
  return sessionEventBusPort;
}

/** 测试后解除绑定，防止模块级装配状态污染其他用例。 */
export function resetSessionEventBusPort(): void {
  sessionEventBusPort = null;
}
