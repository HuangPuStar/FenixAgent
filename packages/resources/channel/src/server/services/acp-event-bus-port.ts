/** Channel 消费 ACP 回复时需要的最小事件字段。 */
export interface AcpEventBusEvent {
  direction: "inbound" | "outbound";
  type: string;
  payload: unknown;
}

/** Hermes 只需订阅指定 Agent 的 ACP 事件总线。 */
export interface AcpEventBusPort {
  getAcpBus(agentId: string): {
    subscribe(listener: (event: AcpEventBusEvent) => void): () => void;
  };
}

let acpEventBusPort: AcpEventBusPort | null = null;

/** 由 apps/server 绑定 Machine 的 ACP 事件总线。 */
export function bindAcpEventBusPort(port: AcpEventBusPort): void {
  acpEventBusPort = port;
}

/** 未绑定时 fail-fast，禁止 Channel 反向依赖 Machine。 */
export function getAcpEventBusPort(): AcpEventBusPort {
  if (!acpEventBusPort) throw new Error("ACP event-bus port has not been bound");
  return acpEventBusPort;
}

/** 测试后重置模块级绑定，避免订阅测试相互污染。 */
export function resetAcpEventBusPort(): void {
  acpEventBusPort = null;
}
