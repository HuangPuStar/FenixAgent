import { afterEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { installPolyfill } from "@/src/lib/clipboard-polyfill";

/**
 * 非安全上下文剪贴板 polyfill 的回归测试。
 *
 * HTTP 部署下 `navigator.clipboard` 与 `ClipboardItem` 都不存在；streamdown 表格复制会先构造
 * `ClipboardItem` 再调用 `clipboard.write`，只补 clipboard 时复制仍然静默失败（VER-REVIEW-002）。
 */

const ORIGINAL_CLIPBOARD = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const ORIGINAL_CLIPBOARD_ITEM = Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem");
const ORIGINAL_DOCUMENT = Object.getOwnPropertyDescriptor(globalThis, "document");

afterEach(() => {
  if (ORIGINAL_CLIPBOARD) Object.defineProperty(navigator, "clipboard", ORIGINAL_CLIPBOARD);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (ORIGINAL_CLIPBOARD_ITEM) Object.defineProperty(globalThis, "ClipboardItem", ORIGINAL_CLIPBOARD_ITEM);
  else Reflect.deleteProperty(globalThis, "ClipboardItem");
  if (ORIGINAL_DOCUMENT) Object.defineProperty(globalThis, "document", ORIGINAL_DOCUMENT);
  else Reflect.deleteProperty(globalThis, "document");
});

/** 模拟 HTTP 环境：剪贴板两个入口都缺失，并装一份只记录 execCommand 内容的 happy-dom。 */
function simulateInsecureContext(): () => string {
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(globalThis, "ClipboardItem");
  const window = initializeHappyDomWindow(new Window());
  let copied = "";
  // happy-dom 的 Document 类型未声明已废弃的 execCommand，按「补齐缺失方法」处理。
  (window.document as unknown as { execCommand: () => boolean }).execCommand = () => {
    copied = (window.document.querySelector("textarea") as HTMLTextAreaElement | null)?.value ?? "";
    return true;
  };
  Object.defineProperty(globalThis, "document", { value: window.document, configurable: true, writable: true });
  return () => copied;
}

describe("installPolyfill（非安全上下文）", () => {
  // 表格复制的完整路径：构造 ClipboardItem → clipboard.write → execCommand 写入 text/plain。
  test("补齐 ClipboardItem 后，表格复制能把 text/plain 写入剪贴板", async () => {
    const readCopied = simulateInsecureContext();
    installPolyfill();

    expect(typeof ClipboardItem).toBe("function");
    const item = new ClipboardItem({
      "text/plain": new Blob(["name\trole\nalice\tadmin"], { type: "text/plain" }),
      "text/html": new Blob(["<table></table>"], { type: "text/html" }),
    });
    await navigator.clipboard.write([item]);

    expect(readCopied()).toBe("name\trole\nalice\tadmin");
  });
});
