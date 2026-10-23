import type { EngineRelayHandle } from "@fenix/plugin-sdk";

interface Continuity {
  token: object;
  unsubscribe?: () => void;
}
const observers = new WeakMap<EngineRelayHandle, Continuity>();

/** 按需观察 Agent 子进程连续性；页面租约归零不代表 Agent 停止。 */
export function readRelayContinuity(physical: EngineRelayHandle): object | undefined {
  if (!physical.onMessage || physical.state !== "open") return;
  let observer = observers.get(physical);
  if (!observer) {
    observer = { token: {} };
    observers.set(physical, observer);
    const current = observer;
    current.unsubscribe = physical.onMessage((message) => {
      const payload = message.payload;
      if (
        message.type === "relay_closed" ||
        (message.type === "status" &&
          typeof payload === "object" &&
          payload !== null &&
          "connected" in payload &&
          payload.connected === false)
      ) {
        current.token = {};
        if (message.type === "relay_closed") disposeRelayContinuity(physical);
      }
    });
  }
  return observer.token;
}

/** 运行实例拥有观察器；物理 relay 关闭时一并释放，不跟随页面引用计数。 */
export function disposeRelayContinuity(physical: EngineRelayHandle): void {
  const observer = observers.get(physical);
  if (!observer) return;
  observers.delete(physical);
  observer.unsubscribe?.();
}
