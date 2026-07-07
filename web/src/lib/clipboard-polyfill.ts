/**
 * Clipboard API polyfill for non-secure (HTTP) contexts.
 *
 * 在 HTTP 环境下，navigator.clipboard 不可用（undefined），导致 streamdown
 * 及项目中所有 copy 按钮静默失败。此 polyfill 用 execCommand('copy') 模拟
 * writeText 方法，使 copy 功能在 HTTP 和 HTTPS 环境下均正常工作。
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

function installPolyfill(): void {
  if (typeof navigator === "undefined") return;

  const polyfill: Clipboard = {
    writeText: (text: string) => execCopy(text),
    readText: () => Promise.reject(new Error("Clipboard read not available in non-secure context")),
    write: () => Promise.reject(new Error("Clipboard write not available in non-secure context")),
    read: () => Promise.reject(new Error("Clipboard read not available in non-secure context")),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  } as unknown as Clipboard;

  try {
    Object.defineProperty(navigator, "clipboard", {
      value: polyfill,
      writable: false,
      configurable: true,
      enumerable: true,
    });
  } catch {
    // 如果 navigator.clipboard 是只读属性（某些浏览器的 HTTPS 场景），
    // polyfill 会静默跳过 —— 此时原生的 Clipboard API 已可用，无需 polyfill。
  }
}

export { installPolyfill };
