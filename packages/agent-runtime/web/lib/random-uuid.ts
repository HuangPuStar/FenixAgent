/**
 * 浏览器安全 UUID v4——chat 出站 Action 的幂等键（`commandId`）与服务端唯一 ID 的生成点。
 *
 * 为什么不直接调 `crypto.randomUUID()`：它仅在 secure context（HTTPS / localhost）下可用，纯 HTTP 部署时
 * 该方法是 `undefined`，直接调用会抛 TypeError（宿主 `apps/web/src/lib/random-uuid.ts` 与
 * `packages/resources/machine/web/lib/random-uuid.ts` 记录了同一取舍）。宿主 `@/src/lib/random-uuid` 是应用壳
 * 模块，包不得反向引用（`web-package-not-to-app`），故本包自持一份。
 *
 * 本包不为此新增 `uuid` 依赖：非 secure context 下 `crypto.getRandomValues` 始终可用（Web Crypto 只有
 * `subtle` 与 `randomUUID` 受 secure context 限制），降级路径按 RFC 4122 v4 手写，与宿主 bootstrap 注入的
 * `random-uuid-polyfill.ts` 同源逻辑。不复用 `uuid@14` 的原因见 machine 包的同一模块：它的 `v4()` 在检测到
 * `crypto.randomUUID` 时直接委托，把 `uuidv4` 注入为 `crypto.randomUUID` 会形成自引用无限递归。
 *
 * 取值语义：`commandId` 只在同一 action 意图重试时复用（见 `use-chat-panel-runtime.ts` 的 commandId 缓存），
 * 因此这里只需要「足够随机、不与其他 client 碰撞」，不需要密码学强度之外的性质。
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
