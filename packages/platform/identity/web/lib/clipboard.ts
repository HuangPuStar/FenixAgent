import { toast } from "sonner";

/** 复制动作的两条用户可见反馈；键由调用方按自己的命名空间翻译后传入，本模块不碰 i18n。 */
export interface CopyMessages {
  copied: string;
  failed: string;
}

/**
 * 复制文本到剪贴板，成功与失败各给一条 toast。
 *
 * 失败分支为什么不能省：`navigator.clipboard` 只在安全上下文（https / localhost）可用，
 * 非安全上下文里 `writeText` 直接拒绝、方法本身也可能不存在。旧写法把返回的 promise 丢在地上，
 * 这两种情况下点了按钮界面毫无反应，用户只会以为已经复制成功。
 *
 * 为什么收在这一处：组织详情头部（2 秒文本回落）、机器行、机器创建结果弹窗此前各写一份，
 * 反馈形态还不一致（一处改本地状态、两处 toast），失败行为则三处都没有。收敛后
 * 「一次写入 + 一条反馈」只有一处定义；受控的文案经参数注入，因此不绑定命名空间。
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
