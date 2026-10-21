import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { flushPendingYjsActions, forwardYjsAction } from "./action-forward";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createClient, createWs } from "./connection-test-helpers";
import { bindGatewayCommandEpoch } from "./gateway-command-epoch";
import type { SessionChannel } from "./session-channel";
import { createConnection, createHarness, createSinks } from "./session-channel-action-test-helpers";

// 网络实时与缓冲转发都必须经过同一严格入口，不能通过内部 raw-ID 入口绕过命令代次。
test("forward and buffered replay both reject raw IDs and accept full client envelopes", async () => {
  const h = createHarness();
  const { connection, relayMessages } = createConnection();
  await h.docManager.openChat("rcs-1");
  const deps = { sessionChannel: h.channel, ...createSinks(h), reportError() {}, reportLog() {} };
  await forwardYjsAction(connection, { action: "set_session_mode", commandId: "raw-one" }, deps);
  await flushPendingYjsActions(
    connection,
    [JSON.stringify({ action: "set_session_mode", commandId: "raw-two" })],
    deps,
  );
  expect(h.errorFrames.map((frame) => frame.error.type)).toEqual(["ACTION.INVALID_STATE", "ACTION.INVALID_STATE"]);
  expect(relayMessages).toEqual([]);
  const full = `${h.channel.getCommandEpoch()}.${randomUUID()}`;
  await forwardYjsAction(connection, { action: "set_session_mode", commandId: full, modeId: "default" }, deps);
  await flushPendingYjsActions(
    connection,
    [JSON.stringify({ action: "set_session_mode", commandId: full, modeId: "default" })],
    deps,
  );
  expect(h.acks.map((ack) => ack.status)).toEqual(["accepted", "committed", "duplicate"]);
  expect(relayMessages).toHaveLength(1);
  await h.docManager.closeAll();
});

// 新代次必须在注册连接上可见，普通64KiB背压拒绝后应关闭重连，不能保持过期的可写连接。
test("epoch broadcast reaches registered clients and closes backpressured sockets", () => {
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  let epoch = randomUUID();
  let changed = () => {};
  const sessionChannel = {
    getCommandEpoch: () => epoch,
    onCommandEpochChanged: (listener: () => void) => {
      changed = listener;
      return () => {};
    },
  } as unknown as SessionChannel;
  const send = bindGatewayCommandEpoch({ registry, broadcaster, sessionChannel, reportError() {} });
  const fast = createWs();
  const slow = createWs(65_537);
  registry.addClient("fast", createClient({ ws: fast }));
  registry.addClient("slow", createClient({ ws: slow }));
  expect(send(fast)).toBe(true);
  epoch = randomUUID();
  changed();
  expect(JSON.parse(String(fast.messages.at(-1)))).toEqual({ type: "yjs:command-epoch", epoch });
  expect(slow.messages).toEqual([]);
  expect(slow.closed).toEqual([[1013, "command epoch unavailable"]]);
});

// 单连接发送、关闭和诊断都抛错时，后续正常客户端仍必须收到新代次，不能被坏连接阻断。
test("epoch broadcast isolates transport and diagnostic failures per connection", () => {
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry, {
    reportLog: () => {
      throw new Error("log failed");
    },
  });
  const epoch = randomUUID();
  let changed = () => {};
  const sessionChannel = {
    getCommandEpoch: () => epoch,
    onCommandEpochChanged: (listener: () => void) => {
      changed = listener;
      return () => {};
    },
  } as unknown as SessionChannel;
  bindGatewayCommandEpoch({
    registry,
    broadcaster,
    sessionChannel,
    reportError: () => {
      throw new Error("sink failed");
    },
  });
  const bad = createWs();
  bad.send = () => {
    throw new Error("send failed");
  };
  bad.close = () => {
    throw new Error("close failed");
  };
  const good = createWs();
  registry.addClient("bad", createClient({ ws: bad }));
  registry.addClient("good", createClient({ ws: good }));
  expect(() => changed()).not.toThrow();
  expect(JSON.parse(String(good.messages.at(-1)))).toEqual({ type: "yjs:command-epoch", epoch });
});
