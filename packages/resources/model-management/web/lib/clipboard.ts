import { toast } from "sonner";

/** 复制动作的两条用户可见反馈；键由调用方按所在命名空间翻译后传入，本模块不碰 i18n。 */
export interface CopyMessages {
  copied: string;
  failed: string;
}

/**
 * 复制文本到剪贴板，成功与失败各给一条 toast。
 *
 * 失败分支为什么不能省：`navigator.clipboard` 只在安全上下文（https / localhost）可用，
 * 非安全上下文里 `writeText` 直接拒绝、方法本身也可能不存在。算法页此前把 promise `void` 掉，
 * 于是「复制代码」点了没有任何反馈——复制成功还是失败，用户只能自己粘贴一次去试。
 *
 * 为什么收在这一处：算法卡片与算法详情弹窗此前各写一份（弹窗一份还带 2 秒文案回落与一个
 * 没有清理的 `setTimeout`）。现在两处共用「一次写入 + 一条 toast」，反馈形态与失败行为只有一处定义。
 */
export function copyTextToClipboard(value: string, messages: CopyMessages): void {
  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText !== "function") {
    toast.error(messages.failed);
    return;
  }
  clipboard.writeText(value).then(
    () => toast.success(messages.copied),
    () => toast.error(messages.failed),
  );
}
