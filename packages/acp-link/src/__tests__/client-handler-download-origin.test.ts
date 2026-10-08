import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * daemon 把 skill 下载 origin 注入到三个引擎 handler 的接线守卫。
 *
 * **为什么必须钉住**：`RCS_URL` 是 daemon / 容器侧部署键，launchSpec 里的 skill URL 由宿主按自身 base URL
 * 生成——容器里的 `localhost` 指向容器自己。改写的唯一执行点在 daemon 进程，而 daemon 一旦漏传
 * `downloadOrigin`，installer 会静默退回原始 URL（这是「未注入即不改写」的既有语义），症状是容器部署下载
 * skill 失败，且不会在宿主侧报错。三个插件包各自的用例只覆盖 installer / handler 内部，看不到这条接线。
 */
const captured: Array<{ engine: string; options: unknown }> = [];

function stubHandler(): unknown {
  // InstanceManager 只在 startInstance / prepareWorkspace 时触达 handler，构造期不需要真实实现。
  return {
    prepareWorkspace: async () => {},
    startInstance: async () => ({ capabilities: {} }),
  };
}

mock.module("@fenix/ccb", () => ({
  createCcbHandler: (_binary?: string, _args?: string[], options?: unknown) => {
    captured.push({ engine: "ccb", options });
    return stubHandler();
  },
}));
mock.module("@fenix/opencode", () => ({
  createOpencodeHandler: (_binary?: string, _args?: string[], options?: unknown) => {
    captured.push({ engine: "opencode", options });
    return stubHandler();
  },
}));
mock.module("@fenix/peri", () => ({
  createPeriHandler: (_binary?: string, _args?: string[], options?: unknown) => {
    captured.push({ engine: "peri", options });
    return stubHandler();
  },
}));
mock.module("@fenix/claude-code", () => ({
  createClaudeCodeHandler: () => {
    captured.push({ engine: "claude-code", options: undefined });
    return stubHandler();
  },
}));

const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");

/** 只满足 createAcpClient 构造期需要的形状；测试不触达任何收发路径。 */
class InertWebSocket {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

describe("createAcpClient 的 skill 下载 origin 接线", () => {
  beforeEach(() => {
    captured.length = 0;
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: InertWebSocket });
  });

  afterEach(() => {
    if (webSocketDescriptor) Object.defineProperty(globalThis, "WebSocket", webSocketDescriptor);
    else Reflect.deleteProperty(globalThis, "WebSocket");
    mock.restore();
  });

  // 三个改写 skill URL 的引擎必须拿到同一个 rcsUrl；漏传就会静默退回宿主地址。
  test("把 rcsUrl 作为 downloadOrigin 交给三个引擎 handler", async () => {
    const { createAcpClient } = await import("../server.js");
    const handle = createAcpClient({
      port: 9315,
      host: "127.0.0.1",
      command: "opencode",
      args: [],
      cwd: "/tmp/acp-link-download-origin",
      rcsUrl: "ws://rcs:3000",
      machineId: "mach-download-origin",
    });
    handle.close();

    const byEngine = new Map(captured.map((item) => [item.engine, item.options]));
    expect([...byEngine.keys()].sort()).toEqual(["ccb", "claude-code", "opencode", "peri"]);
    expect(byEngine.get("ccb")).toEqual({ downloadOrigin: "ws://rcs:3000" });
    expect(byEngine.get("opencode")).toEqual({ downloadOrigin: "ws://rcs:3000" });
    expect(byEngine.get("peri")).toEqual({ downloadOrigin: "ws://rcs:3000" });
  });
});
