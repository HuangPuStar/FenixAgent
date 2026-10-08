import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";

const win = initializeHappyDomWindow(new Window());
const globals = globalThis as Record<string, unknown>;
const originalGlobals = new Map(
  ["window", "document", "navigator", "HTMLElement", "Element", "Node", "CustomEvent"].map((key) => [
    key,
    globals[key],
  ]),
);
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.HTMLElement = win.HTMLElement;
globals.Element = win.Element;
globals.Node = win.Node;
globals.CustomEvent = win.CustomEvent;

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

/** 一段形态与真实密钥一致的假明文（非任何环境在用的密钥）。 */
const FAKE_KEY = "probe_FAKEKEYVALUE0000000000000000000000000000000000000000000000000000";

let written: string[] = [];
let execCommandResult = false;
let selectedWhenCopied = "";

beforeEach(() => {
  written = [];
  execCommandResult = false;
  selectedWhenCopied = "";
  Object.defineProperty(win.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (value: string) => {
        written.push(value);
        return Promise.resolve();
      },
    },
  });
  win.document.execCommand = (() => {
    // 记录调用瞬间的选区：降级路径必须先把密钥整段选中再复制。
    selectedWhenCopied = win.getSelection()?.toString() ?? "";
    return execCommandResult;
  }) as unknown as typeof win.document.execCommand;
});

describe("新建 API Key 的复制", () => {
  // 安全上下文（HTTPS / localhost）必须走统一剪贴板原语，且写入的正是完整密钥明文。
  test("安全上下文下通过 clipboard.writeText 写入完整密钥", async () => {
    Object.defineProperty(win, "isSecureContext", { configurable: true, value: true });
    const { copyApiKeyValue } = await import("../pages/agent-panel/pages/agent-api-keys-utils");
    const code = win.document.createElement("code");
    code.textContent = FAKE_KEY;
    win.document.body.appendChild(code);

    const copied = await copyApiKeyValue(FAKE_KEY, code as unknown as HTMLElement);

    expect(copied).toBe(true);
    expect(written).toEqual([FAKE_KEY]);
  });

  // 非安全上下文下宿主 polyfill（隐藏 textarea）在模态弹窗里会因焦点陷阱失败，
  // 因此必须跳过剪贴板 API，直接退回「选中框内 code 再 execCommand」，才能复制成功。
  test("非安全上下文下退回选中 code 再 execCommand，不调用剪贴板 API", async () => {
    Object.defineProperty(win, "isSecureContext", { configurable: true, value: false });
    execCommandResult = true;
    const { copyApiKeyValue } = await import("../pages/agent-panel/pages/agent-api-keys-utils");
    const code = win.document.createElement("code");
    code.textContent = FAKE_KEY;
    win.document.body.appendChild(code);

    const copied = await copyApiKeyValue(FAKE_KEY, code as unknown as HTMLElement);

    expect(copied).toBe(true);
    expect(written).toEqual([]);
    // 复制发生在「整段密钥已选中」的状态下，之后必须清掉选区，避免密钥长时间停留在选中态。
    expect(selectedWhenCopied).toBe(FAKE_KEY);
    expect(win.getSelection()?.isCollapsed).toBe(true);
  });

  // 两条路径都失败时要回传 false，调用方据此弹「复制失败」提示，而不是静默成功。
  test("两条复制路径都失败时返回 false", async () => {
    Object.defineProperty(win, "isSecureContext", { configurable: true, value: false });
    execCommandResult = false;
    const { copyApiKeyValue } = await import("../pages/agent-panel/pages/agent-api-keys-utils");

    expect(await copyApiKeyValue(FAKE_KEY, null)).toBe(false);
    expect(written).toEqual([]);
  });
});
