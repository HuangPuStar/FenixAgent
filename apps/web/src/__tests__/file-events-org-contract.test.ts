// web/src/__tests__/file-events-org-contract.test.ts
// 实时通道的两条前端不变量（规范 §3.3 / §5.8 / §8.6）：
//
// 1. **组织 id 只经契约获取**：`packages/web-runtime/web/lib/active-org.ts` 是唯一读
//    `active_org_id` 的地方（身份包的 fetch 拦截器与两条 WS 通道都消费它）。任何新增的
//    `localStorage.getItem` 直读都会让"UI 显示 A、连接操作 B"的 split-brain 重新长出来，
//    而且只在切换组织后的窗口期暴露。
// 2. **URL 拼装不在组件里**：`/web/file-events` 的 URL 与协议解析落在宿主域模块
//    `api/file-events.ts`，组件只消费入口；WebSocket / EventSource 的实例化不得出现在
//    组件与页面目录下。

import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { ACTIVE_ORG_STORAGE_KEY } from "@fenix/web-runtime/lib/active-org";
import { Window } from "happy-dom";
import { buildFileEventsUrl, type FileEventsFrame, openFileEventsConnection } from "../api/file-events";

const repoRoot = resolve(import.meta.dir, "../../../..");

const win = initializeHappyDomWindow(new Window());
const globalScope = globalThis as Record<string, unknown>;
globalScope.window = win;
globalScope.document = win.document;
globalScope.navigator = win.navigator;

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");

/** 假 WebSocket：只实现域模块触达的面（send / readyState / 事件挂载点）。 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

/** 最小 localStorage 替身：测试进程没有浏览器全局，用完在 afterEach 还原，避免跨文件泄漏。 */
function stubActiveOrg(activeOrgId?: string): void {
  const store = new Map<string, string>();
  if (activeOrgId !== undefined) store.set(ACTIVE_ORG_STORAGE_KEY, activeOrgId);
  // 同 api-client.test.ts：`globalThis.localStorage` 可能是只读属性（CI 与同进程其它测试文件
  // 装过的替身），直接赋值会抛 TypeError，必须经 defineProperty 定义。
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  });
}

afterEach(() => {
  FakeWebSocket.instances = [];
  for (const [name, descriptor] of [
    ["localStorage", originalLocalStorage],
    ["WebSocket", originalWebSocket],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

/** 收集前端源码文件（组件/页面/包 web 面），排除测试与构建产物。 */
async function collectFrontendSources(globs: Array<{ cwd: string; pattern: string }>): Promise<string[]> {
  const files: string[] = [];
  for (const { cwd, pattern } of globs) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd })) {
      if (file.includes("__tests__") || file.includes(".test.") || file.includes("node_modules")) continue;
      files.push(resolve(cwd, file));
    }
  }
  return files;
}

describe("file-events 域模块（§8.1 通道二）", () => {
  // 组织参数只经契约读取：持久层有激活组织时，URL 必须带上 active_org_id——
  // WS 握手无法带自定义头，这是该值唯一的传递通道。
  test("组织参数经契约进入 WS URL", () => {
    stubActiveOrg("org-1");
    const url = new URL(buildFileEventsUrl());

    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/web/file-events");
    expect(url.searchParams.get("active_org_id")).toBe("org-1");
  });

  // 契约未取到组织时不得拼空参数（服务端按 header → query → cookie 判定归属，空串会被当成一个值）。
  test("无持久化组织时不拼 active_org_id 参数", () => {
    stubActiveOrg();
    const url = new URL(buildFileEventsUrl());

    expect(url.searchParams.has("active_org_id")).toBe(false);
    expect(url.searchParams.get("instanceUid")).toBeNull();
  });

  // 连接建立后必须立刻发出订阅帧，并把服务端帧归一为调用方可直接做去抖的语义。
  test("打开连接后发订阅帧并归一变更帧", () => {
    stubActiveOrg("org-1");
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
    const frames: FileEventsFrame[] = [];
    let opened = 0;
    let closed = 0;

    const connection = openFileEventsConnection("env-1", {
      onOpen: () => {
        opened += 1;
      },
      onFrame: (frame) => frames.push(frame),
      onClose: () => {
        closed += 1;
      },
    });
    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toContain("/web/file-events?active_org_id=org-1");

    socket?.open();
    expect(socket?.sent).toEqual([JSON.stringify({ type: "subscribe", environments: ["env-1"] })]);
    expect(connection.isOpen()).toBe(true);

    socket?.receive({ type: "invalidate_all", environment_id: "env-1" });
    socket?.receive({ type: "file_changed_batch", environment_id: "env-1" });
    socket?.receive({ type: "file_changed", environment_id: "env-1" });
    // 其他环境的事件不得越过订阅边界（同一浏览器可能同时开着多个环境）
    socket?.receive({ type: "invalidate_all", environment_id: "env-2" });

    expect(frames.map((frame) => frame.kind)).toEqual(["invalidate_all", "file_changed", "file_changed"]);
    expect(opened).toBe(1);

    connection.close();
    expect(socket?.closed).toBe(true);
    expect(closed).toBe(1);
  });
});

describe("组织 id 读取契约（§3.3）", () => {
  // 全仓前端源码里读 active_org_id 的位置必须**只有**契约模块一处：
  // 直读会绕过组织上下文，制造「界面显示 A、实时连接操作 B」的分裂。
  test("只有 active-org 契约模块读 active_org_id", async () => {
    const files = await collectFrontendSources([
      { cwd: resolve(repoRoot, "apps/web/src"), pattern: "**/*.{ts,tsx}" },
      { cwd: resolve(repoRoot, "packages"), pattern: "**/web/**/*.{ts,tsx}" },
    ]);
    expect(files.length).toBeGreaterThan(100);

    const readers: string[] = [];
    for (const file of files) {
      const content = await Bun.file(file).text();
      if (/localStorage\s*\.\s*getItem\(\s*(?:"active_org_id"|ACTIVE_ORG_STORAGE_KEY)/.test(content)) {
        readers.push(file.slice(repoRoot.length + 1));
      }
    }

    expect(readers).toEqual(["packages/web-runtime/web/lib/active-org.ts"]);
  });

  // 写入侧同样只允许一处：身份的乐观写与失败回滚都在 `switchOrg` / `refreshOrgs` 里成对出现，
  // 别处再写一次就会出现「本地快照被第二个人改掉、服务端却没切」的另一种 split-brain（§3.6）。
  // 键常量必须从契约模块取，不得在写入点重写字面量。
  test("只有身份的 OrgContext 写 active_org_id", async () => {
    const files = await collectFrontendSources([
      { cwd: resolve(repoRoot, "apps/web/src"), pattern: "**/*.{ts,tsx}" },
      { cwd: resolve(repoRoot, "packages"), pattern: "**/web/**/*.{ts,tsx}" },
    ]);

    const writers: string[] = [];
    const literalWriters: string[] = [];
    for (const file of files) {
      const content = await Bun.file(file).text();
      if (/localStorage\s*\.\s*(?:setItem|removeItem)\(\s*ACTIVE_ORG_STORAGE_KEY/.test(content)) {
        writers.push(file.slice(repoRoot.length + 1));
      }
      if (/localStorage\s*\.\s*(?:setItem|removeItem)\(\s*"active_org_id"/.test(content)) {
        literalWriters.push(file.slice(repoRoot.length + 1));
      }
    }

    expect(writers).toEqual(["packages/platform/identity/web/contexts/OrgContext.tsx"]);
    expect(literalWriters).toEqual([]);
  });
});

describe("WS URL 拼装位置（§5.8）", () => {
  // 组件与页面目录下不得实例化 WebSocket / EventSource（URL 拼装的直接形态）：
  // 实时通道的入口一律由域模块（`api/**`）暴露。
  test("组件与页面不实例化 WebSocket / EventSource", async () => {
    const files = await collectFrontendSources([
      { cwd: resolve(repoRoot, "apps/web/src/components"), pattern: "**/*.{ts,tsx}" },
      { cwd: resolve(repoRoot, "apps/web/src/pages"), pattern: "**/*.{ts,tsx}" },
    ]);
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const file of files) {
      const content = await Bun.file(file).text();
      if (/new\s+(?:WebSocket|EventSource)\s*\(/.test(content)) offenders.push(file.slice(repoRoot.length + 1));
    }

    expect(offenders).toEqual([]);
  });
});
