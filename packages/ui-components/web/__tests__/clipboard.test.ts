import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { copyDialogTextToClipboard, copyTextToClipboard } from "@fenix/ui-components/lib/clipboard";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";

/**
 * 剪贴板原语的机制测试：只验证「写什么、回传什么」，**不碰真实系统剪贴板**。
 *
 * 每个用例用 `Object.defineProperty` 换掉 `navigator.clipboard`，用例结束还原原属性描述符
 * （原属性不存在就删掉）——`bun test` 在同一进程内依次求值全部测试文件，桩不允许泄漏给后续文件。
 */

const ORIGINAL_CLIPBOARD = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function stubClipboard(value: unknown): void {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true, writable: true });
}

afterEach(() => {
  if (ORIGINAL_CLIPBOARD) Object.defineProperty(navigator, "clipboard", ORIGINAL_CLIPBOARD);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("copyDialogTextToClipboard", () => {
  // HTTP 的隐藏 textarea polyfill 即使假报成功，也不能挡住框内 code 的真实复制路径。
  test("非安全上下文跳过假成功的 polyfill 并复制框内文本", async () => {
    const win = initializeHappyDomWindow(new Window());
    const globals = globalThis as Record<string, unknown>;
    const originalWindow = globals.window;
    const originalDocument = globals.document;
    let polyfillCalls = 0;
    let clipboardValue = "previous";
    stubClipboard({
      writeText: async () => {
        polyfillCalls += 1;
      },
    });
    Object.defineProperty(win, "isSecureContext", { configurable: true, value: false });
    const code = win.document.createElement("code");
    code.textContent = "first line\nsecond line";
    win.document.body.appendChild(code);
    win.document.execCommand = (() => {
      clipboardValue = win.getSelection()?.toString() ?? "";
      return true;
    }) as typeof win.document.execCommand;
    globals.window = win;
    globals.document = win.document;

    try {
      expect(await copyDialogTextToClipboard(code.textContent, code as unknown as HTMLElement)).toBe(true);
      expect(polyfillCalls).toBe(0);
      expect(clipboardValue).toBe("first line\nsecond line");
    } finally {
      if (originalWindow === undefined) delete globals.window;
      else globals.window = originalWindow;
      if (originalDocument === undefined) delete globals.document;
      else globals.document = originalDocument;
    }
  });
});

describe("copyTextToClipboard", () => {
  // 通用文本复制成功时应原样写入，并向调用方返回成功。
  test("写入成功：回传 true，且原样写入传入的文本", async () => {
    const written: string[] = [];
    stubClipboard({
      writeText: async (text: string) => {
        written.push(text);
      },
    });

    await expect(copyTextToClipboard("org_1a2b3c")).resolves.toBe(true);
    expect(written).toEqual(["org_1a2b3c"]);
  });

  // 非安全上下文且宿主未装 polyfill 时，应返回失败供调用方反馈。
  test("navigator.clipboard 缺失：回传 false 而不抛错", async () => {
    stubClipboard(undefined);
    await expect(copyTextToClipboard("x")).resolves.toBe(false);
  });

  // 浏览器仅提供其它剪贴板方法时，不应误判文本复制成功。
  test("clipboard 存在但没有 writeText：回传 false，不误报成功", async () => {
    stubClipboard({ write: async () => {} });
    await expect(copyTextToClipboard("x")).resolves.toBe(false);
  });

  // 权限被拒或窗口失焦导致异步写入失败时，应保留失败结果。
  test("writeText 返回 rejected promise：回传 false", async () => {
    stubClipboard({ writeText: () => Promise.reject(new Error("NotAllowedError")) });
    await expect(copyTextToClipboard("x")).resolves.toBe(false);
  });

  // 浏览器实现同步抛错时，也应由调用方收到失败结果。
  test("writeText 同步抛错：回传 false 而不是把异常抛给调用方", async () => {
    stubClipboard({
      writeText: () => {
        throw new Error("boom");
      },
    });
    await expect(copyTextToClipboard("x")).resolves.toBe(false);
  });

  // 通用文本原语不应混入弹窗专用 DOM 选择逻辑；两个出口仍不依赖 UI 或 i18n。
  test("通用文本原语保持无 DOM 依赖，剪贴板模块不依赖 UI", () => {
    const source = readFileSync(join(import.meta.dir, "..", "lib", "clipboard.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    for (const forbidden of ["sonner", "react-i18next", "react"]) {
      expect(code.includes(forbidden), `剪贴板模块的运行时代码里不应出现 ${forbidden}`).toBe(false);
    }
    const textPrimitive = code.split("export async function copyDialogTextToClipboard")[0];
    for (const forbidden of ["execCommand", "document"]) {
      expect(textPrimitive.includes(forbidden), `通用文本原语的运行时代码里不应出现 ${forbidden}`).toBe(false);
    }
  });
});
