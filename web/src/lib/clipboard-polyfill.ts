/**
 * Clipboard API polyfill for non-secure (HTTP) contexts.
 *
 * 在 HTTP 环境下，navigator.clipboard 为 undefined，导致 streamdown 及项目中
 * 所有 copy 按钮静默失败。此 polyfill 用 execCommand('copy') 模拟 writeText
 * 和 write 方法，使 copy 功能在 HTTP 和 HTTPS 环境下均正常工作。
 *
 * streamdown 内部使用两种 clipboard 调用路径：
 * - 代码块/链接复制 → navigator.clipboard.writeText(text)
 * - 表格复制       → navigator.clipboard.write([ClipboardItem])
 * 本 polyfill 同时覆盖这两种路径。
 *
 * 挂载时机：在 bootstrap.ts 中最先执行，早于 React 渲染。
 */

function execCopy(text: string): Promise<void> {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.left = "-9999px";
  textarea.style.top = "-9999px";
  textarea.setAttribute("readonly", "");
  document.body.appendChild(textarea);

  return new Promise<void>((resolve, reject) => {
    try {
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      if (ok) {
        resolve();
      } else {
        reject(new Error("execCommand('copy') returned false"));
      }
    } catch (err) {
      reject(err);
    } finally {
      document.body.removeChild(textarea);
    }
  });
}

/**
 * 从 ClipboardItem 数组中提取 text/plain 内容并通过 execCommand 复制。
 * streamdown 表格复制创建 { text/plain + text/html } 的 ClipboardItem，
 * 降级方案只复制 text/plain（文本内容），忽略 HTML 富文本。
 */
async function writeClipboardItems(items: ClipboardItem[]): Promise<void> {
  for (const item of items) {
    if (item.types.includes("text/plain")) {
      const blob = await item.getType("text/plain");
      const text = await blob.text();
      return execCopy(text);
    }
  }
  throw new Error("No text/plain in clipboard items for polyfill");
}

function createPolyfill(): Clipboard {
  return {
    writeText: (text: string) => execCopy(text),
    write: (items: ClipboardItem[]) => writeClipboardItems(items),
    readText: () => Promise.reject(new Error("Clipboard read not available in non-secure context")),
    read: () => Promise.reject(new Error("Clipboard read not available in non-secure context")),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  } as unknown as Clipboard;
}

function installPolyfill(): void {
  if (typeof navigator === "undefined") return;

  // HTTPS 环境下原生 Clipboard API 已可用，跳过 polyfill
  // 用 any 绕过 TS 对 navigator.clipboard 的类型推断（运行时可能为 undefined）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // biome-ignore lint/suspicious/noExplicitAny: navigator.clipboard may be undefined at runtime, any bypass required
  const existing = (navigator as any).clipboard;
  if (existing && typeof existing.writeText === "function") return;

  const polyfill = createPolyfill();

  try {
    Object.defineProperty(navigator, "clipboard", {
      value: polyfill,
      writable: false,
      configurable: true,
      enumerable: true,
    });
    console.debug("[clipboard-polyfill] installed — execCommand fallback active");
  } catch {
    // navigator.clipboard 已存在且不可覆写（部分浏览器的 HTTPS 场景），
    // 此时原生 API 可用，无需 polyfill
    console.debug("[clipboard-polyfill] skipped — native clipboard in use");
  }
}

export { installPolyfill };
