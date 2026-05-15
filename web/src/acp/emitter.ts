/**
 * 类型安全的 EventEmitter，所有 ACP 模块共用。
 */
export type Handler<T = void> = T extends void ? () => void : (payload: T) => void;

export class EventEmitter<Events extends Record<string, any>> {
  private handlers = new Map<string, Set<Handler<any>>>();

  on<Event extends keyof Events>(event: Event, handler: Handler<Events[Event]>): void {
    let set = this.handlers.get(event as string);
    if (!set) {
      set = new Set();
      this.handlers.set(event as string, set);
    }
    set.add(handler);
  }

  off<Event extends keyof Events>(event: Event, handler: Handler<Events[Event]>): void {
    const set = this.handlers.get(event as string);
    if (set) {
      set.delete(handler);
    }
  }

  emit<Event extends keyof Events>(event: Event, ...args: Events[Event] extends void ? [] : [Events[Event]]): void {
    const set = this.handlers.get(event as string);
    if (set) {
      for (const handler of set) {
        handler(...args);
      }
    }
  }

  removeAllListeners(event?: keyof Events): void {
    if (event !== undefined) {
      this.handlers.delete(event as string);
    } else {
      this.handlers.clear();
    }
  }
}
