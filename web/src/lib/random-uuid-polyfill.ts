/**
 * crypto.randomUUID polyfill for non-secure (HTTP) contexts.
 *
 * crypto.randomUUID 仅在 secure context（HTTPS / localhost）下可用：纯 HTTP 部署时
 * crypto 对象存在但缺少 randomUUID 方法，任何直接调用都会抛 TypeError。本 polyfill
 * 在该场景下注入 RFC 4122 v4 实现，使全局 crypto.randomUUID 在 HTTP / HTTPS 环境下
 * 均可正常工作——已有调用点无需感知降级，未来新增的调用点也不会再踩 secure context
 * 的坑。
 *
 * 注入实现为何手写而非复用 uuid 库的 uuidv4()：
 * uuid@14 的 v4() 无参调用存在快速路径——检测到 crypto.randomUUID 存在时直接委托
 * （node_modules/uuid/dist/v4.js: `if (!buf && !options && crypto.randomUUID)
 * return crypto.randomUUID()`）。若把 uuidv4 注入为 crypto.randomUUID，调用即形成
 * 自引用无限递归（uuidv4 → crypto.randomUUID → uuidv4 → …）。因此这里手写基于
 * crypto.getRandomValues 的 RFC 4122 v4 实现：getRandomValues 在非 secure context
 * 同样可用（Web Crypto 仅 subtle / randomUUID 受限），且不存在自引用。
 *
 * 挂载时机：在 bootstrap.ts 中最先执行，早于 React 渲染与任何业务模块加载。
 */

/**
 * 基于 crypto.getRandomValues 生成 RFC 4122 v4 UUID（非 secure context 下 getRandomValues
 * 始终可用）。版本位（第 13 个 hex 字符）与变体位（第 17 个 hex 字符）按标准设置。
 */
function uuidV4ViaGetRandomValues(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function installRandomUUIDPolyfill(): void {
  if (typeof globalThis === "undefined") return;
  if (typeof globalThis.crypto === "undefined") return;

  // 用 any 绕过 TS 对 crypto.randomUUID 的类型推断（DOM lib 声明其始终存在，
  // 但非 secure context 下运行时可能为 undefined）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // biome-ignore lint/suspicious/noExplicitAny: crypto.randomUUID may be undefined in non-secure contexts, any bypass required
  const existing = (globalThis.crypto as any).randomUUID;
  if (typeof existing === "function") return;

  try {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: uuidV4ViaGetRandomValues,
      writable: false,
      configurable: true,
      enumerable: true,
    });
    console.debug("[random-uuid-polyfill] installed — uuid fallback active (non-secure context)");
  } catch {
    // 定义失败（极端情况下 crypto 对象被冻结）时保持现状：业务侧 utils.randomUUID()
    // 仍有独立的降级路径，不在此处抛出
    console.debug("[random-uuid-polyfill] skipped — crypto.randomUUID unavailable and not injectable");
  }
}

export { installRandomUUIDPolyfill };
