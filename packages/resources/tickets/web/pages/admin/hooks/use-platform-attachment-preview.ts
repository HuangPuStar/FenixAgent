/**
 * 平台管理面的附件预览编排：取回字节（带 `Authorization`）→ 图片用 objectURL 预览，其余直接下载。
 *
 * **为什么不能像控制台面那样把缩略图指向下载端点**：那一面的凭据是会话 cookie，`<img src>` 自带；管理面的
 * 凭据是 `Authorization` 头，`<img>` / `<a>` 都带不上，只能先用 `fetch` 取回 `Blob`（数据源端口的
 * `attachments.download`，实现即 `downloadTicketBytes`），图片再转成 objectURL 喂给 `<img>`。
 *
 * **objectURL 的生命周期是本模块的主要职责**：它会把那份字节一直钉在内存里，直到 `revokeObjectURL`。因此
 * 三条释放路径都必须走同一个 `release()`：关闭覆盖层、切换到另一张图、组件卸载（返回列表、换工单、关页面）；
 * 在途请求同时被 abort——用户关掉预览后，一次 10 MiB 的传输不该继续跑完。
 *
 * **非图片没有可预览的内容**：直接走「取回 + 落盘」（与控制台面的下载同一出口 `saveBlobAsFile`），失败只
 * 给 toast（没有覆盖层可承载内联提示）；图片的失败留在覆盖层里，带重试。
 *
 * 会话内不做缓存：预览是低频动作，而缓存 blob 会让「什么时候释放」变成第二个生命周期问题。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { systemTicketDataSource } from "../../../api/system-tickets";
import type { TicketAttachment } from "../../../api/ticket-attachments";
import { saveBlobAsFile } from "../../../api/ticket-attachments";
import { TICKETS_NS } from "../../../i18n/namespace";
import { isImageAttachmentName } from "../../agent-panel/components/ticket-attachment-preview";

/** 覆盖层的三个可达状态；`ready` 必有 `objectUrl`。 */
export type PlatformAttachmentPreviewStatus = "loading" | "ready" | "failed";

export interface PlatformAttachmentPreviewState {
  /** 正在预览的附件；`null` 表示没有覆盖层（非图片走下载，不进这里）。 */
  target: TicketAttachment | null;
  status: PlatformAttachmentPreviewStatus;
  /** 已取回的图片地址（objectURL）；`loading` / `failed` 时为 `null`。 */
  objectUrl: string | null;
  /** 失败原因：服务端信封原文优先，取不到时由覆盖层回退到字典文案。 */
  errorMessage: string | null;
  /** 「点击打开」：图片进预览覆盖层，非图片直接下载。 */
  open: (attachment: TicketAttachment) => void;
  /** 失败后重试当前这张图。 */
  retry: () => void;
  /** 关闭覆盖层并释放 objectURL。 */
  close: () => void;
}

interface PreviewSession {
  target: TicketAttachment | null;
  status: PlatformAttachmentPreviewStatus;
  objectUrl: string | null;
  errorMessage: string | null;
}

const IDLE: PreviewSession = { target: null, status: "loading", objectUrl: null, errorMessage: null };

export function usePlatformAttachmentPreview(projectId: string, number: string): PlatformAttachmentPreviewState {
  const { t } = useTranslation(TICKETS_NS);
  const [session, setSession] = useState<PreviewSession>(IDLE);
  const objectUrlRef = useRef<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  // 数据源动作：`systemTicketDataSource.attachments.download` 就是带 `Authorization` 的
  // `downloadTicketBytes(url, { bearerToken })`（见 `api/system-tickets.ts`），因此这里不再自己拼 URL。
  const { download } = systemTicketDataSource.attachments;

  /** 开始一次新的取字节动作：中断上一次（图片预览与非图片下载共用同一条在途通道，连点只保留最后一次）。 */
  const beginRequest = useCallback((): AbortController => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return controller;
  }, []);

  /** 唯一释放出口：中断在途请求 + 撤销 objectURL（见文件头）。 */
  const release = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (objectUrlRef.current !== null) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const loadImage = useCallback(
    async (attachment: TicketAttachment): Promise<void> => {
      // 先释放上一张：切换图片时旧 objectURL 若不撤销，每张图都会各留一份字节在内存里。
      release();
      const controller = beginRequest();
      setSession({ target: attachment, status: "loading", objectUrl: null, errorMessage: null });
      try {
        const blob = await download(projectId, number, attachment.attachmentId, controller.signal);
        // 取消（关闭/切换）后不再落地：`revokeObjectURL` 已经跑过，此时再挂上去就再也无人释放。
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        setSession({ target: attachment, status: "ready", objectUrl: url, errorMessage: null });
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("platform attachment preview failed", error);
        setSession({
          target: attachment,
          status: "failed",
          objectUrl: null,
          errorMessage: error instanceof Error && error.message.length > 0 ? error.message : null,
        });
      }
    },
    [beginRequest, download, number, projectId, release],
  );

  const open = useCallback(
    (attachment: TicketAttachment): void => {
      if (isImageAttachmentName(attachment.name)) {
        void loadImage(attachment);
        return;
      }
      // 非图片：取回即落盘（与控制台面的下载同一出口），失败只提示——没有覆盖层承载内联错误与重试。
      // 与图片预览共用同一条在途通道：连点两次或随后打开图片时，前一次落盘会被取消，不写出两份文件。
      void (async () => {
        const controller = beginRequest();
        try {
          const blob = await download(projectId, number, attachment.attachmentId, controller.signal);
          if (controller.signal.aborted) return;
          saveBlobAsFile(blob, attachment.name);
        } catch (error) {
          if (controller.signal.aborted) return;
          console.error("platform attachment download failed", error);
          toast.error(
            error instanceof Error && error.message.length > 0 ? error.message : t("attachment.downloadFailed"),
          );
        }
      })();
    },
    [beginRequest, download, loadImage, number, projectId, t],
  );

  const close = useCallback((): void => {
    release();
    setSession(IDLE);
  }, [release]);

  const retry = useCallback((): void => {
    if (session.target !== null) void loadImage(session.target);
  }, [loadImage, session.target]);

  // 卸载即释放：返回列表、换工单、关页面都走这条路径（effect 的清理函数在卸载时执行）。
  useEffect(() => release, [release]);

  return { ...session, close, open, retry };
}
