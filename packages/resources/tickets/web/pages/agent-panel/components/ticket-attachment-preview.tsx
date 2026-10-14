/**
 * 附件列表里的图片缩略图与放大预览。
 *
 * **为什么按扩展名判定而不是 MIME**：附件列表视图只有编号、名字、字节数与时间——上游的列表响应不含 MIME，
 * 类型只在下载响应的头里（`lib` 与协议层都不额外多发一次请求）。因此「像不像图片」只能看扩展名，并接受它
 * 会说谎：真取不到图时 `onError` 回退为不渲染缩略图（文件行与下载按钮都还在，功能不依赖预览）。
 *
 * **为什么缩略图直接指向下载端点**：图片内容只经本服务代理（上游地址带服务账号凭据，不进浏览器），而
 * `<img src>` 是同源请求、浏览器自带会话 cookie，正好复用 `sessionAuth` 那一层——为预览再造一个
 * 「先 fetch 成 blob 再 objectURL」的通道只会多一份要手工释放的生命周期。
 */

import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TICKETS_NS } from "../../../i18n/namespace";

/**
 * 可预览的图片扩展名（小写，不含点）。
 *
 * 取常见位图与矢量图；不追求覆盖全部浏览器支持的格式——漏判的代价只是「这类附件没有缩略图」，而误判
 * （把一个普通文件当图片渲染）由 `onError` 兜住，两者都不影响下载。
 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"]);

/** 附件名是否像图片（按扩展名判定；判错的两种情况都由调用方回退处理）。 */
export function isImageAttachmentName(name: string): boolean {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dotIndex + 1).toLowerCase());
}

export interface TicketAttachmentThumbProps {
  /** 附件名：进 `alt` 与预览弹层的标题（读屏用户据此知道看的是哪个文件）。 */
  name: string;
  /** 下载端点地址（缩略图与放大图共用同一次代理，不额外请求元数据）。 */
  url: string;
}

/** 图片缩略图：点击放大；取不到图时静默回退（不占位、不报错）。 */
export function TicketAttachmentThumb({ name, url }: TicketAttachmentThumbProps) {
  const { t } = useTranslation(TICKETS_NS);
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);

  if (broken) return null;

  return (
    <>
      <Button
        aria-label={t("attachment.preview")}
        className="size-10 shrink-0 overflow-hidden rounded-md border border-border bg-surface-2 p-0"
        onClick={() => setOpen(true)}
        type="button"
        variant="ghost"
      >
        {/* `loading="lazy"`：工单可能有多个附件，滚不到的缩略图不必立刻下载整份原图。 */}
        <img alt={name} className="size-full object-cover" loading="lazy" onError={() => setBroken(true)} src={url} />
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="p-3">
          <DialogTitle className="sr-only">{name}</DialogTitle>
          <img alt={name} className="max-h-[82vh] w-full object-contain" src={url} />
        </DialogContent>
      </Dialog>
    </>
  );
}
