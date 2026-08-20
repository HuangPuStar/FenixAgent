import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAcpClient, type ServerConfig } from "../server.js";

class InMemoryWebSocket {
  static instances: InMemoryWebSocket[] = [];
  static remainingFileWsConstructionFailures = 0;

  readyState = 0;
  sent: string[] = [];
  closeCalls = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    if (url.includes("/acp/file-ws") && InMemoryWebSocket.remainingFileWsConstructionFailures > 0) {
      InMemoryWebSocket.remainingFileWsConstructionFailures--;
      throw new Error("simulated file-ws construction failure");
    }
    InMemoryWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls++;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  message(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  error(): void {
    this.onerror?.(new Event("error"));
  }

  closed(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code: 1000 }));
  }
}

const config: ServerConfig = {
  port: 9315,
  host: "127.0.0.1",
  command: "opencode",
  args: [],
  cwd: "/tmp/acp-link-round68-no-server",
  rcsUrl: "ws://registry.invalid",
};

const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
const setTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
const clearTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
const setIntervalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setInterval");
const clearIntervalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearInterval");

let timeoutCallbacks = new Map<number, () => void>();
let intervalCallbacks = new Map<number, () => void>();
let nextTimerId = 0;
let handles: Array<{ close(): void }> = [];

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, name);
  }
}

async function waitForSockets(count: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && InMemoryWebSocket.instances.length < count; attempt++) {
    await Bun.sleep(1);
  }
  expect(InMemoryWebSocket.instances).toHaveLength(count);
}

function runIntervals(): void {
  for (const callback of intervalCallbacks.values()) callback();
}

describe("createAcpClient round 68 离线生命周期分支", () => {
  beforeEach(() => {
    InMemoryWebSocket.instances = [];
    InMemoryWebSocket.remainingFileWsConstructionFailures = 0;
    timeoutCallbacks = new Map();
    intervalCallbacks = new Map();
    nextTimerId = 0;
    handles = [];
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: InMemoryWebSocket });
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: (callback: () => void) => {
        const id = ++nextTimerId;
        timeoutCallbacks.set(id, callback);
        return id;
      },
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      value: (id: number) => timeoutCallbacks.delete(id),
    });
    Object.defineProperty(globalThis, "setInterval", {
      configurable: true,
      value: (callback: () => void) => {
        const id = ++nextTimerId;
        intervalCallbacks.set(id, callback);
        return id;
      },
    });
    Object.defineProperty(globalThis, "clearInterval", {
      configurable: true,
      value: (id: number) => intervalCallbacks.delete(id),
    });
  });

  afterEach(() => {
    for (const handle of handles) handle.close();
    restoreGlobal("WebSocket", webSocketDescriptor);
    restoreGlobal("setTimeout", setTimeoutDescriptor);
    restoreGlobal("clearTimeout", clearTimeoutDescriptor);
    restoreGlobal("setInterval", setIntervalDescriptor);
    restoreGlobal("clearInterval", clearIntervalDescriptor);
  });

  // 注册完成后主通道与文件通道都必须按各自协议发送保活帧。
  test("主通道和文件通道发送保活帧", async () => {
    handles.push(createAcpClient(config));
    await waitForSockets(1);
    const mainSocket = InMemoryWebSocket.instances[0];
    if (!mainSocket) throw new Error("main socket was not created");
    mainSocket.open();
    mainSocket.message('{"type":"registered"}');
    const fileSocket = InMemoryWebSocket.instances[1];
    if (!fileSocket) throw new Error("file socket was not created");
    fileSocket.open();

    runIntervals();

    expect(mainSocket.sent.map((message) => JSON.parse(message))).toContainEqual({ type: "heartbeat" });
    expect(fileSocket.sent.map((message) => JSON.parse(message))).toContainEqual({ type: "keep_alive" });
  });

  // 主通道意外断开时必须关闭文件通道并清理两个通道的保活定时器。
  test("主通道关闭会清理文件通道和保活定时器", async () => {
    handles.push(createAcpClient(config));
    await waitForSockets(1);
    const mainSocket = InMemoryWebSocket.instances[0];
    if (!mainSocket) throw new Error("main socket was not created");
    mainSocket.open();
    mainSocket.message('{"type":"registered"}');
    const fileSocket = InMemoryWebSocket.instances[1];
    if (!fileSocket) throw new Error("file socket was not created");
    fileSocket.open();

    mainSocket.closed();

    expect(fileSocket.closeCalls).toBe(1);
    expect(intervalCallbacks.size).toBe(0);
    expect(timeoutCallbacks.size).toBe(1);
  });

  // Node.js 连接失败可能只触发 error；文件通道必须仍然安排重连，且重复 close 不得重复调度。
  test("文件通道仅触发 error 时仍会重连", async () => {
    handles.push(createAcpClient(config));
    await waitForSockets(1);
    const mainSocket = InMemoryWebSocket.instances[0];
    if (!mainSocket) throw new Error("main socket was not created");
    mainSocket.message('{"type":"registered"}');
    const fileSocket = InMemoryWebSocket.instances[1];
    if (!fileSocket) throw new Error("file socket was not created");

    fileSocket.error();
    fileSocket.closed();

    expect(timeoutCallbacks.size).toBe(1);

    const [reconnect] = timeoutCallbacks.values();
    reconnect?.();

    expect(InMemoryWebSocket.instances).toHaveLength(3);
  });

  // chat relay 恢复时，即使本地仍误判旧 file-ws 为 OPEN，也必须换链重新 register。
  test("chat relay connect 会强制重建文件通道", async () => {
    handles.push(createAcpClient(config));
    await waitForSockets(1);
    const mainSocket = InMemoryWebSocket.instances[0];
    if (!mainSocket) throw new Error("main socket was not created");
    mainSocket.message('{"type":"registered"}');
    const fileSocket = InMemoryWebSocket.instances[1];
    if (!fileSocket) throw new Error("file socket was not created");
    fileSocket.open();

    mainSocket.message('{"type":"relay","instance_id":"inst-1","session_id":"ses-1","payload":{"type":"connect"}}');

    expect(timeoutCallbacks.size).toBe(0);
    expect(fileSocket.closeCalls).toBe(1);
    expect(InMemoryWebSocket.instances).toHaveLength(3);
    expect(InMemoryWebSocket.instances[2]?.url).toContain("/acp/file-ws");
  });

  // 文件通道构造异常时也必须进入退避重连，避免 sandbox 重启窗口永久失联。
  test("文件通道构造失败时仍会重连", async () => {
    InMemoryWebSocket.remainingFileWsConstructionFailures = 1;
    handles.push(createAcpClient(config));
    await waitForSockets(1);
    const mainSocket = InMemoryWebSocket.instances[0];
    if (!mainSocket) throw new Error("main socket was not created");

    mainSocket.message('{"type":"registered"}');

    expect(timeoutCallbacks.size).toBe(1);

    const [reconnect] = timeoutCallbacks.values();
    reconnect?.();

    expect(InMemoryWebSocket.instances).toHaveLength(2);
    expect(InMemoryWebSocket.instances[1]?.url).toContain("/acp/file-ws");
  });

  // node_id 异步读取尚未完成时关闭客户端，后续回调不得再创建 WebSocket。
  test("关闭后阻止延迟初始化连接", async () => {
    const handle = createAcpClient(config);
    handle.close();
    handles.push(handle);

    await Bun.sleep(5);

    expect(InMemoryWebSocket.instances).toEqual([]);
  });
});
