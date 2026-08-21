import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import type { ActionError } from "../channel/types";
import {
  decodeYjsSyncFrame,
  encodeYjsUpdateFrame,
  MAX_YJS_SYNC_PAYLOAD_BYTES,
  YJS_UPDATE_FRAME_TYPE,
} from "../protocol/update-frame";
import { createYjsWsClient } from "../transport/ws";

type ScheduledTimer = {
  callback: () => void;
  cleared: boolean;
  delay: number | undefined;
};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  closeCalls = 0;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "client_disconnect" } as CloseEvent);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  closeFromServer(code = 1006, reason = "connection_lost"): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  receiveFromServer(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  /** 服务端二进制 yjs:update 帧（SP-A4）：以 ArrayBuffer 形态到达（binaryType=arraybuffer） */
  receiveBinaryFromServer(data: ArrayBuffer | Uint8Array): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  send(_data: string): void {}
}

const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
const originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
const originalClearTimeout = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
let timers: ScheduledTimer[];

function installFakes(): void {
  FakeWebSocket.instances = [];
  timers = [];

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: (callback: () => void, delay?: number) => {
      const timer = { callback, cleared: false, delay };
      timers.push(timer);
      return timer;
    },
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    value: (timer: ScheduledTimer) => {
      timer.cleared = true;
    },
  });
}

function restoreGlobal(
  name: "WebSocket" | "setTimeout" | "clearTimeout",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, name);
  }
}

function runNextTimer(): void {
  const timer = timers.shift();
  if (!timer) throw new Error("预期存在重连定时器");
  if (!timer.cleared) timer.callback();
}

function createClient(onConnectionState?: (state: "connecting" | "connected" | "disconnected" | "error") => void) {
  return createYjsWsClient({
    url: "ws://example.test/acp/yjs/agent_1",
    onYjsUpdate: () => {},
    onConnectionState,
  });
}

describe("createYjsWsClient", () => {
  beforeEach(() => {
    installFakes();
  });

  afterEach(() => {
    restoreGlobal("WebSocket", originalWebSocket);
    restoreGlobal("setTimeout", originalSetTimeout);
    restoreGlobal("clearTimeout", originalClearTimeout);
  });

  // 网络持续中断时，客户端应按指数退避逐步延长重连等待时间，避免持续冲击服务端。
  test("连续断线使用递增的重连延迟", () => {
    const client = createClient();
    client.connect();

    FakeWebSocket.instances[0]?.closeFromServer();
    expect(timers[0]?.delay).toBe(1000);

    runNextTimer();
    FakeWebSocket.instances[1]?.closeFromServer();
    expect(timers[0]?.delay).toBe(2000);

    runNextTimer();
    FakeWebSocket.instances[2]?.closeFromServer();
    expect(timers[0]?.delay).toBe(4000);
  });

  // 连接曾成功恢复后，下一次断线应从最短退避时间重新开始。
  test("连接成功后重置重连延迟", () => {
    const client = createClient();
    client.connect();

    FakeWebSocket.instances[0]?.closeFromServer();
    runNextTimer();
    FakeWebSocket.instances[1]?.open();
    FakeWebSocket.instances[1]?.closeFromServer();

    expect(timers[0]?.delay).toBe(1000);
  });

  // 面板或调用方销毁客户端后，已排队的重连不得再创建新的连接。
  test("disconnect 取消已排队的重连", () => {
    const client = createClient();
    client.connect();
    FakeWebSocket.instances[0]?.closeFromServer();

    const timer = timers[0];
    client.disconnect();

    expect(timer?.cleared).toBe(true);
    runNextTimer();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  // 主动断开会同步触发 close 回调时，只能显式通知一次断开且不得排队重连。
  test("disconnect 的同步 close 不重复通知或重连", () => {
    const states: string[] = [];
    const client = createClient((state) => states.push(state));
    client.connect();
    FakeWebSocket.instances[0]?.open();

    client.disconnect();

    expect(states).toEqual(["connecting", "connected", "disconnected"]);
    expect(timers).toHaveLength(0);
  });

  // 已销毁客户端收到迟到 close 时，不得重复断开通知或排队重连。
  test("disconnect 后的迟到 close 不重复通知或重连", () => {
    const states: string[] = [];
    const client = createClient((state) => states.push(state));
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.open();

    client.disconnect();
    socket?.closeFromServer();

    expect(states).toEqual(["connecting", "connected", "disconnected"]);
    expect(timers).toHaveLength(0);
  });

  // 旧连接迟到关闭时，不能覆盖新连接状态或为旧连接额外排队重连。
  test("旧 socket 的迟到 close 不影响新 socket", () => {
    const states: string[] = [];
    const client = createClient((state) => states.push(state));
    client.connect();
    const oldSocket = FakeWebSocket.instances[0];
    oldSocket?.closeFromServer();
    runNextTimer();
    const newSocket = FakeWebSocket.instances[1];
    newSocket?.open();

    oldSocket?.closeFromServer();

    expect(states).toEqual(["connecting", "disconnected", "connecting", "connected"]);
    expect(timers).toHaveLength(0);
  });

  // 服务端 error 帧必须透传安全的 code 和 message，不能被当作 Yjs update 丢弃。
  test("forwards server error frames to onError", () => {
    const errors: Array<{ code?: string; message?: string }> = [];
    const client = createYjsWsClient({
      url: "ws://example.test/acp/yjs/agent_1",
      onYjsUpdate: () => {},
      onError: (error) => errors.push(error),
    });
    client.connect();

    FakeWebSocket.instances[0]?.receiveFromServer({
      type: "error",
      payload: { code: "machine_unavailable", message: "Agent connection error" },
    });

    expect(errors).toEqual([{ code: "machine_unavailable", message: "Agent connection error" }]);
  });

  // action_error 帧必须透传完整 ActionError 对象给 onActionError，
  // 且不触发 onYjsUpdate / onError（错误分流，避免误判为连接级错误）。
  test("forwards action_error frames to onActionError without touching other callbacks", () => {
    const actionErrors: ActionError[] = [];
    const yjsUpdates: string[] = [];
    const wsErrors: Array<{ code?: string; message?: string }> = [];
    const client = createYjsWsClient({
      url: "ws://example.test/acp/yjs/agent_1",
      onYjsUpdate: (docName) => yjsUpdates.push(docName),
      onError: (error) => wsErrors.push(error),
      onActionError: (error) => actionErrors.push(error),
    });
    client.connect();

    FakeWebSocket.instances[0]?.receiveFromServer({
      type: "action_error",
      commandId: "c1",
      code: "RATE_LIMITED",
      message: "too many requests",
      retryable: true,
    });

    expect(actionErrors).toEqual([
      {
        type: "action_error",
        commandId: "c1",
        code: "RATE_LIMITED",
        message: "too many requests",
        retryable: true,
      },
    ]);
    expect(yjsUpdates).toHaveLength(0);
    expect(wsErrors).toHaveLength(0);
  });

  // 未注册 onActionError 时 action_error 帧静默忽略（不抛错、不影响其他分支）。
  test("action_error frames are ignored when onActionError is absent", () => {
    const client = createClient();
    client.connect();
    FakeWebSocket.instances[0]?.receiveFromServer({
      type: "action_error",
      commandId: "c1",
      code: "AGENT_UNAVAILABLE",
      message: "agent offline",
      retryable: true,
    });
  });

  // 终端关闭码必须向上层提供 code 和 reason，并切换为 error 状态而不是继续自动重连。
  test("reports terminal close details and stops reconnecting", () => {
    const states: string[] = [];
    const closes: Array<{ code: number; reason: string }> = [];
    const client = createYjsWsClient({
      url: "ws://example.test/acp/yjs/agent_1",
      onYjsUpdate: () => {},
      onConnectionState: (state) => states.push(state),
      onClose: (close) => closes.push(close),
    });
    client.connect();
    FakeWebSocket.instances[0]?.closeFromServer(4001, "instance_idle_reclaimed");

    expect(closes).toEqual([{ code: 4001, reason: "instance_idle_reclaimed" }]);
    expect(states).toEqual(["connecting", "error"]);
    expect(timers).toHaveLength(0);
  });

  // 服务端以 idle reclaim 关闭时，客户端必须停止自动重连，等待上层生命周期重新建连。
  test("4001 关闭码不自动重连", () => {
    const client = createClient();
    client.connect();
    FakeWebSocket.instances[0]?.closeFromServer(4001, "idle_reclaim");

    expect(timers).toHaveLength(0);
  });

  // 远程机器不可用时，继续建连无法恢复服务，客户端必须停止自动重连。
  test("4500 关闭码不自动重连", () => {
    const client = createClient();
    client.connect();
    FakeWebSocket.instances[0]?.closeFromServer(4500, "machine offline");

    expect(timers).toHaveLength(0);
  });

  // 同 machine 已有连接时，重复连接属于永久冲突，客户端必须停止自动重连。
  test("4503 关闭码不自动重连", () => {
    const client = createClient();
    client.connect();
    FakeWebSocket.instances[0]?.closeFromServer(4503, "machine already connected");

    expect(timers).toHaveLength(0);
  });

  // 服务端因客户端 keepalive 超时关闭时，客户端必须终止且不得排队自动重连。
  test("4501 关闭码不自动重连", () => {
    const client = createClient();
    client.connect();
    FakeWebSocket.instances[0]?.closeFromServer(4501, "client keepalive timeout");

    expect(timers).toHaveLength(0);
  });

  // spawn 被配置性永久失败拒绝（autoStart 关闭等）时，重连不会改变失败条件，
  // 客户端必须停止自动重连并交由上层展示手动重试入口。
  test("4502 关闭码不自动重连", () => {
    const client = createClient();
    client.connect();
    FakeWebSocket.instances[0]?.closeFromServer(4502, "spawn rejected");

    expect(timers).toHaveLength(0);
  });

  // 会话/环境引用失效（4004，如 env 已删除）时，重试相同 URL 永远失败：
  // 客户端必须停止自动重连并进入 error 终态，交由上层展示手动恢复入口。
  test("4004 关闭码不自动重连且进入 error 终态", () => {
    const states: string[] = [];
    const client = createClient((state) => states.push(state));
    client.connect();
    FakeWebSocket.instances[0]?.closeFromServer(4004, "env not found");

    expect(states).toEqual(["connecting", "error"]);
    expect(timers).toHaveLength(0);
  });
});

describe("createYjsWsClient 二进制 yjs:update 帧（SP-A4）", () => {
  beforeEach(() => {
    installFakes();
  });

  afterEach(() => {
    restoreGlobal("WebSocket", originalWebSocket);
    restoreGlobal("setTimeout", originalSetTimeout);
    restoreGlobal("clearTimeout", originalClearTimeout);
  });

  // 服务端 yjs:update 二进制帧（ArrayBuffer 形态）必须零拷贝解析为
  // (docName, update) 并可直接 Y.applyUpdate——替代历史 base64+JSON 慢解码路径。
  test("解析 ArrayBuffer 形态的二进制 yjs:update 帧", () => {
    const doc = new Y.Doc();
    doc.getMap("root").set("hello", "binary");
    const frame = encodeYjsUpdateFrame("chat:rcs-1", Y.encodeStateAsUpdate(doc));
    const updates: Array<{ docName: string; update: Uint8Array }> = [];
    const client = createYjsWsClient({
      url: "ws://example.test/acp/yjs/agent_1",
      onYjsUpdate: (docName, update) => updates.push({ docName, update }),
    });
    client.connect();

    FakeWebSocket.instances[0]?.receiveBinaryFromServer(frame.slice().buffer);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.docName).toBe("chat:rcs-1");
    const restored = new Y.Doc();
    Y.applyUpdate(restored, updates[0]!.update);
    expect(restored.getMap("root").get("hello")).toBe("binary");
  });

  // Bun / 测试环境可能直接透传 Uint8Array 视图，同样必须正确解析。
  test("解析 Uint8Array 视图形态的二进制 yjs:update 帧", () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "view-frame");
    const frame = encodeYjsUpdateFrame("session:rcs-1", Y.encodeStateAsUpdate(doc));
    const updates: string[] = [];
    const client = createYjsWsClient({
      url: "ws://example.test/acp/yjs/agent_1",
      onYjsUpdate: (docName) => updates.push(docName),
    });
    client.connect();

    FakeWebSocket.instances[0]?.receiveBinaryFromServer(frame);

    expect(updates).toEqual(["session:rcs-1"]);
  });

  // 坏二进制帧（帧类型不符 / 长度越界）必须静默丢弃，不得抛错中断连接。
  test("坏二进制帧被静默丢弃", () => {
    const updates: string[] = [];
    const client = createYjsWsClient({
      url: "ws://example.test/acp/yjs/agent_1",
      onYjsUpdate: (docName) => updates.push(docName),
    });
    client.connect();

    const wrongType = new Uint8Array([0x02, 0x00, 0x01, 0x63]);
    const truncated = new Uint8Array([YJS_UPDATE_FRAME_TYPE, 0xff, 0xff, 0x01]);
    FakeWebSocket.instances[0]?.receiveBinaryFromServer(wrongType);
    FakeWebSocket.instances[0]?.receiveBinaryFromServer(truncated);

    expect(updates).toHaveLength(0);
  });

  // 建连后必须设置 binaryType=arraybuffer，保证浏览器端二进制帧以
  // ArrayBuffer（同步可解析）而非 Blob（需异步解包）形态到达。
  test("连接建立时设置 binaryType 为 arraybuffer", () => {
    const client = createClient();
    client.connect();

    const socket = FakeWebSocket.instances[0] as unknown as { binaryType?: string };
    expect(socket.binaryType).toBe("arraybuffer");
  });
});

describe("generation frame payload 边界", () => {
  // 合法 payload 恰好达到 8 MiB 上限时仍可编码并无损解码。
  test("accepts payload exactly at the configured bound", () => {
    const payload = new Uint8Array(MAX_YJS_SYNC_PAYLOAD_BYTES);
    payload[payload.length - 1] = 7;
    const decoded = decodeYjsSyncFrame(encodeYjsUpdateFrame("chat:rcs-bound", "gen-bound", payload));
    expect(decoded?.type).toBe("update");
    expect(decoded?.type === "update" ? decoded.update.length : 0).toBe(MAX_YJS_SYNC_PAYLOAD_BYTES);
  });

  // payload 超过 8 MiB 一字节必须在分配 WS 帧前被明确拒绝。
  test("rejects payload one byte above the configured bound", () => {
    const payload = new Uint8Array(MAX_YJS_SYNC_PAYLOAD_BYTES + 1);
    expect(() => encodeYjsUpdateFrame("chat:rcs-bound", "gen-bound", payload)).toThrow("Yjs payload too large");
  });
});
