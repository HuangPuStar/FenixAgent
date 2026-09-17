import { afterEach, expect, test } from "bun:test";
import { EventBus } from "../../transport/event-bus";
import {
  bindSessionEventBusPort,
  getSessionEventBusPort,
  resetSessionEventBusPort,
} from "../services/session-event-bus-port";

afterEach(() => resetSessionEventBusPort());

// Session 只能通过宿主绑定的窄事件总线端口访问 Machine 所有的事件服务。
test("session event-bus port 绑定后透传查询与释放", () => {
  const buses = new Map([["ses_1", new EventBus()]]);
  const removed: string[] = [];
  bindSessionEventBusPort({
    getAllBuses: () => buses,
    removeBus: (sessionId) => removed.push(sessionId),
  });

  expect(getSessionEventBusPort().getAllBuses()).toBe(buses);
  getSessionEventBusPort().removeBus("ses_1");
  expect(removed).toEqual(["ses_1"]);
});
