import { afterEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { ACTIVE_ORG_STORAGE_KEY } from "@fenix/web-runtime/lib/active-org";
import { Window } from "happy-dom";
import { buildYjsUrl, getTerminalYjsWsErrorCode } from "../yjs/yjs-ws";

// buildYjsUrl 依赖 window.location，组织参数经持久层契约读取；两者都在这里补齐最小环境。
const win = initializeHappyDomWindow(new Window());
const globalScope = globalThis as Record<string, unknown>;
globalScope.window = win;
globalScope.document = win.document;
globalScope.navigator = win.navigator;

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

/** 最小 localStorage 替身：测试进程没有浏览器全局，用完在 afterEach 还原，避免跨文件泄漏。 */
function stubLocalStorage(initial?: string): void {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set(ACTIVE_ORG_STORAGE_KEY, initial);
  globalScope.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

const locator = { instanceUid: "inst-1", rcsSessionId: "rcs-1" };

describe("yjs websocket adapter", () => {
  afterEach(() => {
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  // 本文件只做项目侧包装：URL 构造依赖浏览器 API，连接/重连/消息解析委托 @fenix/chat-channel。
  test("仅保留 URL 与 transport 适配能力", () => {
    expect(typeof buildYjsUrl).toBe("function");
  });

  // 组织参数只经契约（@fenix/web-runtime/lib/active-org）读取：设置持久值后 URL 必须带上
  // active_org_id——WS 握手无法带 X-Active-Org-Id 头，这是该值唯一的传递通道。
  test("URL 的组织参数经契约读取", () => {
    stubLocalStorage("org-1");
    const url = new URL(buildYjsUrl("agent_1", locator));

    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/acp/yjs/agent_1");
    expect(url.searchParams.get("active_org_id")).toBe("org-1");
    expect(url.searchParams.get("instanceUid")).toBe("inst-1");
    expect(url.searchParams.get("rcsSessionId")).toBe("rcs-1");
  });

  // 契约未取到组织（未登录/未解析出组织）时不得拼出空参数：服务端按 header → query → cookie
  // 的优先级提取组织，空串会被当成一个值参与判定。
  test("无持久化组织时不拼 active_org_id 参数", () => {
    stubLocalStorage();
    const url = new URL(buildYjsUrl("agent_1", locator));

    expect(url.searchParams.has("active_org_id")).toBe(false);
    expect(url.searchParams.get("rcsSessionId")).toBe("rcs-1");
  });

  // 终态关闭码 → UI 语义。词表本体已收敛到 @fenix/chat-channel 的关闭码策略表
  // （transport/ws-close-codes.ts），这里锁住**改前的逐码判定结果**，防止收敛引入行为变化。
  test("逐码返回 UI 语义错误码", () => {
    expect(getTerminalYjsWsErrorCode(4001)).toBe("instance_idle_reclaimed");
    expect(getTerminalYjsWsErrorCode(4004)).toBe("environment_unavailable");
    expect(getTerminalYjsWsErrorCode(4500)).toBe("machine_unavailable");
    expect(getTerminalYjsWsErrorCode(4501)).toBe("client_keepalive_timeout");
    expect(getTerminalYjsWsErrorCode(4502)).toBe("spawn_rejected");
    // 4503 返回 null 是**已知缺口**（docs/developer/guide/frontend-development.md §8.3/§8.6）：
    // 传输层停重连但 UI 拿不到可展示语义。补语义会让该场景出现新的用户可见提示 = 行为变化，
    // 本测试固定现状，改动此处必须先改文档并单独评估。
    expect(getTerminalYjsWsErrorCode(4503)).toBeNull();
    // 未知码 / 非终态码不产生 UI 语义
    expect(getTerminalYjsWsErrorCode(1000)).toBeNull();
    expect(getTerminalYjsWsErrorCode(1006)).toBeNull();
    expect(getTerminalYjsWsErrorCode(4003)).toBeNull();
  });

  // 1013 的两个语义来源按 close reason 区分；例外只对该码生效。
  test("1013 按关闭原因区分终态与非终态", () => {
    expect(getTerminalYjsWsErrorCode(1013)).toBe("too_many_connections");
    expect(getTerminalYjsWsErrorCode(1013, "unknown reason")).toBe("too_many_connections");
    expect(getTerminalYjsWsErrorCode(1013, "slow consumer resync timeout")).toBeNull();
    // 例外不得扩散：其他终态码即使携带同一 reason 仍按自身语义判定
    expect(getTerminalYjsWsErrorCode(4001, "slow consumer resync timeout")).toBe("instance_idle_reclaimed");
    expect(getTerminalYjsWsErrorCode(4503, "slow consumer resync timeout")).toBeNull();
  });
});
