import { error as logError } from "@fenix/logger";
import { NODE_ID } from "./store/node-id";

export interface SessionEvent {
  id: string;
  sessionId: string;
  type: string;
  payload: unknown;
  direction: "inbound" | "outbound";
  seqNum: number;
  createdAt: number;
}

type Subscriber = (event: SessionEvent) => void;

const MAX_EVENTS_PER_BUS = 5000;

export class EventBus {
  private subscribers = new Set<Subscriber>();
  private events: SessionEvent[] = [];
  private seqNum = 0;
  private closed = false;

  subscribe(callback: Subscriber): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  publish(event: Omit<SessionEvent, "seqNum" | "createdAt">): SessionEvent {
    if (this.closed) throw new Error("EventBus is closed");
    const full: SessionEvent = {
      ...event,
      seqNum: ++this.seqNum,
      createdAt: Date.now(),
    };
    this.events.push(full);
    // Evict oldest events when exceeding limit
    if (this.events.length > MAX_EVENTS_PER_BUS) {
      this.events = this.events.slice(-Math.floor(MAX_EVENTS_PER_BUS / 2));
    }
    for (const cb of this.subscribers) {
      try {
        cb(full);
      } catch (err) {
        logError(`[EventBus] subscriber error:`, err);
      }
    }

    // 跨节点广播：通过 TransportStore Pub/Sub 发送到其他 RCS 节点
    // 消息携带 _nodeId 用于去重：接收节点跳过自己发出的消息
    try {
      import("./store/factory").then(({ getTransportStore }) => {
        getTransportStore()
          .publish("eventbus", JSON.stringify({ _nodeId: NODE_ID, ...full }))
          .catch((err) => logError("[EventBus] cross-node publish error:", err));
      });
    } catch {
      // TransportStore 未初始化时忽略（测试环境）
    }

    return full;
  }

  getLastSeqNum(): number {
    return this.seqNum;
  }

  getEventsSince(seqNum: number): SessionEvent[] {
    const idx = this.events.findIndex((e) => e.seqNum > seqNum);
    if (idx === -1) return [];
    return this.events.slice(idx);
  }

  /**
   * 注入跨节点到来的事件，仅触发本地 subscriber，不再次跨节点广播。
   * 用于解决 EventBus 双重投递问题：跨节点 subscribe 消费端调用此方法将远程事件回灌到本地，
   * 避免 publish → 再次广播 → 无限循环。
   */
  inject(event: SessionEvent): void {
    if (this.closed) return;
    this.events.push(event);
    // Evict oldest events when exceeding limit
    if (this.events.length > MAX_EVENTS_PER_BUS) {
      this.events = this.events.slice(-Math.floor(MAX_EVENTS_PER_BUS / 2));
    }
    if (event.seqNum > this.seqNum) {
      this.seqNum = event.seqNum;
    }
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch (err) {
        logError(`[EventBus] subscriber error:`, err);
      }
    }
  }

  close() {
    this.closed = true;
    this.subscribers.clear();
  }
}

/** Global registry of per-session event buses */
const buses = new Map<string, EventBus>();

export function getEventBus(sessionId: string): EventBus {
  let bus = buses.get(sessionId);
  if (!bus) {
    bus = new EventBus();
    buses.set(sessionId, bus);
  }
  return bus;
}

export function removeEventBus(sessionId: string) {
  const bus = buses.get(sessionId);
  if (bus) {
    bus.close();
    buses.delete(sessionId);
  }
}

export function getAllEventBuses(): Map<string, EventBus> {
  return buses;
}

/** Global registry of per-channel-group ACP event buses */
const acpBuses = new Map<string, EventBus>();

export function getAcpEventBus(channelGroupId: string): EventBus {
  let bus = acpBuses.get(channelGroupId);
  if (!bus) {
    bus = new EventBus();
    acpBuses.set(channelGroupId, bus);
  }
  return bus;
}

export function removeAcpEventBus(channelGroupId: string) {
  const bus = acpBuses.get(channelGroupId);
  if (bus) {
    bus.close();
    acpBuses.delete(channelGroupId);
  }
}
