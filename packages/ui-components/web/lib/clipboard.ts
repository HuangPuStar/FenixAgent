/**
 * 剪贴板写入原语。
 *
 * 机制最小化：**只做「写一段文本 + 回传成功与否」**——不含 i18n、不含 toast、不绑定任何 UI。
 * 反馈形态（toast / 图标或文案的 2 秒回落 / 静默）是调用方的选择：库内不直接调宿主 `toast`
 * （见 docs/developer/guide/frontend-development.md §5.8），文案由调用方翻译后自己拼。
 *
 * `navigator.clipboard` 只在**安全上下文**（https / localhost）由浏览器提供，http 下为 `undefined`；
 * 宿主 `apps/web` 在 `main.tsx` 里最先执行 `lib/clipboard-polyfill.ts`，用隐藏 textarea +
 * `execCommand("copy")` 把 `writeText` 补上，因此正常运行时这个缺口已被兜住。无论走哪条路，本函数
 * 对「API 缺失」与「写入被拒」**一律回传 `false` 而不抛错**——调用方据此给出失败反馈，不要静默丢弃。
 *
 * 为什么原语自己不做 `execCommand` 降级：宿主那份 polyfill 已是全仓唯一的降级实现（见上），再抄一份
 * 只会得到第三种写法；它覆盖不了的场景也不是「写一段文本」能表达的——Radix 模态框内复制会因为
 * FocusScope 的焦点陷阱而失效（`focus()` 被同步抢回、隐藏 textarea 的选中内容随之丢失，2026-07
 * 的真实缺陷），那里唯一可行的写法是「选中框内已有元素再 execCommand」，需要 DOM 元素而非一段文本，
 * 因此留在调用点（`packages/platform/identity` 的 `AgentApiKeysPage`）。
 *
 * @param value 要写入剪贴板的文本。
 * @returns 写入成功为 `true`；剪贴板 API 缺失、写入被拒或写入抛错为 `false`。
 */
export async function copyTextToClipboard(value: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText !== "function") return false;
  try {
    await clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
