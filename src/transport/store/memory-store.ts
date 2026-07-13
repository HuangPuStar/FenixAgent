import type { TransportStore } from "./types";

/** 单节点内存实现，使用 JavaScript Map 存储所有状态。pub/sub 通过内存 Set 实现。 */
export class MemoryStore implements TransportStore {
  private relaySockets = new Map<string, string>();
  private machineSockets = new Map<string, string>();
  private channels = new Map<string, Set<(message: string) => void>>();

  async setRelaySocket(instanceId: string, socketId: string): Promise<void> {
    this.relaySockets.set(instanceId, socketId);
  }

  async getRelaySocket(instanceId: string): Promise<string | null> {
    return this.relaySockets.get(instanceId) ?? null;
  }

  async delRelaySocket(instanceId: string): Promise<void> {
    this.relaySockets.delete(instanceId);
  }

  async setMachineSocket(machineId: string, socketId: string): Promise<void> {
    this.machineSockets.set(machineId, socketId);
  }

  async getMachineSocket(machineId: string): Promise<string | null> {
    return this.machineSockets.get(machineId) ?? null;
  }

  async delMachineSocket(machineId: string): Promise<void> {
    this.machineSockets.delete(machineId);
  }

  async publish(channel: string, message: string): Promise<void> {
    const handlers = this.channels.get(channel);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(message);
      } catch (_err) {
        // 忽略单个 handler 的异常，避免影响其他 handler
      }
    }
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => void> {
    let handlers = this.channels.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.channels.set(channel, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.relaySockets.clear();
    this.machineSockets.clear();
    this.channels.clear();
  }
}
