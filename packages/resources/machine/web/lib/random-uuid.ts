/**
 * 浏览器安全 UUID v4——文件写操作幂等 ID（`x-file-op-id`）的生成点。
 *
 * 为什么不直接调 `crypto.randomUUID()`：它仅在 secure context（HTTPS / localhost）下可用，
 * 纯 HTTP 部署时该方法是 `undefined`，直接调用会抛 TypeError（宿主 `apps/web/src/lib/random-uuid.ts`
 * 的注释记录了同一取舍）。宿主版本用 `uuid` 包兜底，本包不为此新增依赖：非 secure context 下
 * `crypto.getRandomValues` 始终可用（Web Crypto 只有 `subtle` 与 `randomUUID` 受 secure context 限制），
 * 降级路径按 RFC 4122 v4 手写，与宿主 bootstrap 注入的 `random-uuid-polyfill.ts` 同源逻辑。
 *
 * 与宿主 polyfill 都不复用 `uuid@14` 的原因相同：其 `v4()` 在检测到 `crypto.randomUUID` 时直接委托，
 * 把 `uuidv4` 注入为 `crypto.randomUUID` 会形成自引用无限递归。
 */

/** 生成 UUID v4：优先用安全上下文的 `crypto.randomUUID`，否则退回 `getRandomValues` 手写实现。 */
export function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return uuidV4ViaGetRandomValues();
}

/** 基于 `crypto.getRandomValues` 的 RFC 4122 v4（版本位与变体位按标准设置）。 */
function uuidV4ViaGetRandomValues(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
