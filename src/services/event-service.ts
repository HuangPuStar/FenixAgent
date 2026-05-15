/**
 * 薄封装 EventBus，作为 service 层的统一入口。
 * 跨层调用方（routes、services）应通过此模块访问 EventBus，
 * 而非直接导入 transport/event-bus。
 */
import {
  getEventBus,
  removeEventBus,
  getAllEventBuses,
  getAcpEventBus,
  removeAcpEventBus,
} from "../transport/event-bus";
import type { EventBus, SessionEvent } from "../transport/event-bus";

type Subscriber = (event: SessionEvent) => void;

export const eventService = {
  publishEvent(sessionId: string, event: Omit<SessionEvent, "seqNum" | "createdAt">): SessionEvent {
    return getEventBus(sessionId).publish(event);
  },

  subscribe(sessionId: string, callback: Subscriber): () => void {
    return getEventBus(sessionId).subscribe(callback);
  },

  getEventsSince(sessionId: string, seqNum: number): SessionEvent[] {
    return getEventBus(sessionId).getEventsSince(seqNum);
  },

  getBus(sessionId: string): EventBus {
    return getEventBus(sessionId);
  },

  removeBus(sessionId: string): void {
    removeEventBus(sessionId);
  },

  getAllBuses(): Map<string, EventBus> {
    return getAllEventBuses();
  },

  getAcpBus(channelGroupId: string): EventBus {
    return getAcpEventBus(channelGroupId);
  },

  removeAcpBus(channelGroupId: string): void {
    removeAcpEventBus(channelGroupId);
  },
};

export type { EventBus, SessionEvent };
