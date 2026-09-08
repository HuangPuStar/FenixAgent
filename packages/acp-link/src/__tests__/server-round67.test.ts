import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAcpClient, type ServerConfig } from "../server.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static throwOnNextConstruction = false;

  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  closeCalls = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    if (FakeWebSocket.throwOnNextConstruction) {
      FakeWebSocket.throwOnNextConstruction = false;
      throw new Error("in-memory connection failed");
    }
    this.url = url;
    FakeWebSocket.instances.push(this);
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

  closed(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
}

const config: ServerConfig = {
  port: 9315,
  host: "127.0.0.1",
  command: "opencode",
  args: [],
  cwd: "/tmp/acp-link-round67",
  rcsUrl: "ws://registry.invalid/base",
  machineId: "mach-round67",
  rcsSecret: "round 67/secret",
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
  for (let attempt = 0; attempt < 100 && FakeWebSocket.instances.length < count; attempt++) {
    await Bun.sleep(1);
  }
  expect(FakeWebSocket.instances).toHaveLength(count);
}

function createClient(): void {
  handles.push(createAcpClient(config));
}

function mainSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances[0];
  if (!socket) throw new Error("main socket was not created");
  return socket;
}

function runTimeouts(): void {
  const callbacks = [...timeoutCallbacks.values()];
  timeoutCallbacks.clear();
  for (const callback of callbacks) callback();
}

describe("createAcpClient round 67 内存传输分支", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.throwOnNextConstruction = false;
    timeoutCallbacks = new Map();
    intervalCallbacks = new Map();
    nextTimerId = 0;
    handles = [];
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
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

  // 缺少注册中心地址必须在建立任何传输前失败。
  test("拒绝缺少 rcsUrl 的客户端配置", () => {
    expect(() => createAcpClient({ ...config, rcsUrl: undefined })).toThrow("rcsUrl is required");
  });

  // 配置 machineId 后应只创建内存主连接，并保留编码后的密钥。
  test("使用编码密钥创建主连接", async () => {
    createClient();
    await waitForSockets(1);
    expect(mainSocket().url).toBe("ws://registry.invalid/base/acp/ws?secret=round%2067%2Fsecret");
  });

  // 主连接打开必须发送 register 帧。
  test("主连接打开时发送注册帧", async () => {
    createClient();
    await waitForSockets(1);
    mainSocket().open();
    expect(JSON.parse(mainSocket().sent[0] ?? "")).toMatchObject({ type: "register", agent_name: "opencode" });
  });

  // 注册确认会创建独立的文件传输连接。
  test("注册确认后创建文件连接", async () => {
    createClient();
    await waitForSockets(1);
    mainSocket().message(
      '{"type":"registered","protocol_version":2,"server_epoch":"epoch-test","clean_slate_required":true}',
    );
    await Bun.sleep(0);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]?.url).toBe("ws://registry.invalid/base/acp/file-ws?secret=round%2067%2Fsecret");
  });

  // 文件连接打开时只向文件通道登记机器标识。
  test("文件连接打开时发送文件注册帧", async () => {
    createClient();
    await waitForSockets(1);
    mainSocket().message(
      '{"type":"registered","protocol_version":2,"server_epoch":"epoch-test","clean_slate_required":true}',
    );
    await Bun.sleep(0);
    const fileSocket = FakeWebSocket.instances[1];
    fileSocket?.open();
    expect(JSON.parse(fileSocket?.sent[0] ?? "")).toEqual({ type: "register" });
  });

  // 重复注册必须关闭旧文件连接，避免旧连接泄漏。
  test("重复注册关闭旧文件连接", async () => {
    createClient();
    await waitForSockets(1);
    mainSocket().message(
      '{"type":"registered","protocol_version":2,"server_epoch":"epoch-test","clean_slate_required":true}',
    );
    await Bun.sleep(0);
    const firstFileSocket = FakeWebSocket.instances[1];
    mainSocket().message(
      '{"type":"registered","protocol_version":2,"server_epoch":"epoch-test","clean_slate_required":true}',
    );
    await Bun.sleep(0);
    expect(firstFileSocket?.closeCalls).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  // 文件连接构造失败应被吞掉，不影响主连接继续运行。
  test("文件连接构造失败不会抛出", async () => {
    createClient();
    await waitForSockets(1);
    FakeWebSocket.throwOnNextConstruction = true;
    mainSocket().message(
      '{"type":"registered","protocol_version":2,"server_epoch":"epoch-test","clean_slate_required":true}',
    );
    await Bun.sleep(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  // 非 file_op 文件帧必须被忽略而不产生响应。
  test("忽略未知文件帧", async () => {
    createClient();
    await waitForSockets(1);
    mainSocket().message(
      '{"type":"registered","protocol_version":2,"server_epoch":"epoch-test","clean_slate_required":true}',
    );
    await Bun.sleep(0);
    const fileSocket = FakeWebSocket.instances[1];
    fileSocket?.message('{"type":"unknown"}');
    await Promise.resolve();
    expect(fileSocket?.sent).toEqual([]);
  });

  // 损坏的文件帧必须走解析错误吞掉分支。
  test("忽略损坏的文件帧", async () => {
    createClient();
    await waitForSockets(1);
    mainSocket().message(
      '{"type":"registered","protocol_version":2,"server_epoch":"epoch-test","clean_slate_required":true}',
    );
    await Bun.sleep(0);
    const fileSocket = FakeWebSocket.instances[1];
    fileSocket?.message("{");
    await Promise.resolve();
    expect(fileSocket?.sent).toEqual([]);
  });

  // 非手动文件断连要安排一次内存重连。
  test("文件连接断开后安排重连", async () => {
    createClient();
    await waitForSockets(1);
    mainSocket().message(
      '{"type":"registered","protocol_version":2,"server_epoch":"epoch-test","clean_slate_required":true}',
    );
    await Bun.sleep(0);
    FakeWebSocket.instances[1]?.closed();
    expect(timeoutCallbacks.size).toBe(1);
    runTimeouts();
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  // 主连接未知帧只能记录，不能意外发送协议数据。
  test("忽略未知主连接帧", async () => {
    createClient();
    await waitForSockets(1);
    mainSocket().message('{"type":"unrecognized"}');
    await Promise.resolve();
    expect(mainSocket().sent).toEqual([]);
  });

  // 主连接损坏 JSON 必须走安全的解析错误分支。
  test("忽略损坏的主连接帧", async () => {
    createClient();
    await waitForSockets(1);
    mainSocket().message("{");
    await Promise.resolve();
    expect(mainSocket().sent).toEqual([]);
  });

  // relay_close 是允许的无操作控制帧。
  test("接受 relay_close 控制帧", async () => {
    createClient();
    await waitForSockets(1);
    mainSocket().message('{"type":"relay_close"}');
    await Promise.resolve();
    expect(mainSocket().sent).toEqual([]);
  });

  // 普通主连接关闭应通过调度器创建新连接。
  test("普通主连接关闭后重连", async () => {
    createClient();
    await waitForSockets(1);
    mainSocket().closed();
    expect(timeoutCallbacks.size).toBe(1);
    runTimeouts();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  // error 与 close 同时到达时，调度器只能保留一个重连任务。
  test("主连接错误和关闭合并为一次重连", async () => {
    createClient();
    await waitForSockets(1);
    mainSocket().error();
    mainSocket().closed();
    expect(timeoutCallbacks.size).toBe(1);
  });

  // 认证失败关闭必须停止重连，避免无效凭据造成重试风暴。
  test("认证失败关闭后不重连", async () => {
    createClient();
    await waitForSockets(1);
    mainSocket().closed(4003, "denied");
    expect(timeoutCallbacks.size).toBe(0);
  });

  // 手动关闭必须清理文件连接并阻止其关闭回调再次调度。
  test("手动关闭清理连接且不重连", async () => {
    createClient();
    await waitForSockets(1);
    mainSocket().message(
      '{"type":"registered","protocol_version":2,"server_epoch":"epoch-test","clean_slate_required":true}',
    );
    await Bun.sleep(0);
    const fileSocket = FakeWebSocket.instances[1];
    handles[0]?.close();
    fileSocket?.closed();
    expect(fileSocket?.closeCalls).toBe(1);
    expect(mainSocket().closeCalls).toBe(1);
    expect(timeoutCallbacks.size).toBe(0);
  });
});
