/**
 * 附件的编排层：列表取数、上传队列（并发 2）、取消与重试、下载。
 *
 * **上传是一次用户动作一批文件、一次远端写一个请求**：服务端一次只收一个文件（一次写入 = 一个幂等键），
 * 因此「每次最多 5 个」由前端拆成最多 5 个请求，「并发 2」由本 hook 的队列调度。队列状态与列表分开持有：
 * 队列是**过程**（可取消、可重试、有失败文案），列表是**结果**（回源托管平台，成功后前插一条）。
 *
 * 三条与写路径共用的口径：
 * 1. 幂等键按任务持有并跨重试复用（同内容重试返回原操作，同内容之外的改动换代）——重试必须复用，
 *    否则第一次超时但已落库的上传会被重写一份，用户看到两个同名附件；
 * 2. 202 上报给详情页唯一的待确认态（`onUncertain`）并从队列移除：重发只会让账本多一条在途；
 * 3. 失败分类复用 `settleTicketWriteFailure`（`IDempotency-Key` 换代、403 不给重试、503 统一文案）。
 *
 * **不因「工单有待确认的写」而禁用上传**：附件没有本地行、彼此不共享状态，服务端也只对同键的在途上传
 * 做互斥（`attachment.upload` 不进工单级短锁），与工单字段/评论的「一笔未确认的写」是两回事。
 */

import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { TicketAttachment } from "../api/ticket-attachments";
import { saveBlobAsFile } from "../api/ticket-attachments";
import type { TicketDataSource } from "../api/ticket-data-source";
import { TICKETS_NS } from "../i18n/namespace";
import {
  formatAttachmentSize,
  planTicketAttachmentSelection,
  TICKET_ATTACHMENT_CONCURRENCY,
  TICKET_ATTACHMENT_MAX_BYTES,
  ticketAttachmentRejectionMessage,
} from "../lib/ticket-attachment-limits";
import { settleTicketWriteFailure } from "../lib/ticket-write-failure";
import {
  createIdempotencyKeyHolder,
  type IdempotencyKeyHolder,
  isUncertainAccepted,
  newIdempotencyKey,
  writeSignature,
} from "../lib/ticket-write-outcome";

/** 队列项的可见状态：`failed` 留在队列里等用户重试或移除，`uploading` 与 `queued` 是过程态。 */
export type TicketAttachmentUploadStatus = "queued" | "uploading" | "failed";

/** 一个上传任务的渲染投影（文件本体与幂等键留在 hook 内部，不上屏）。 */
export interface TicketAttachmentUpload {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly status: TicketAttachmentUploadStatus;
  /** 失败原因（服务端信封原文优先），仅 `failed` 有值。 */
  readonly errorMessage?: string;
}

export interface TicketAttachmentsOptions {
  /** 详情可用时才取列表：详情 404/403 时附件区不会渲染，多发一次注定失败的请求只会多一条 toast。 */
  readonly enabled: boolean;
  /** 202 上报：待确认状态由详情页单点持有（与评论、标签同口径）。 */
  readonly onUncertain: (operationId: string) => void;
}

export interface TicketAttachmentsState {
  /** 服务端返回顺序（上游顺序）；上传成功后新附件前插。 */
  attachments: TicketAttachment[];
  loading: boolean;
  error: Error | undefined;
  /** 首屏重试（也是列表失败分支的「重试」入口）。 */
  retry: () => void;
  /** 未完成与失败的上传任务（按入队顺序）。 */
  uploads: TicketAttachmentUpload[];
  /** 有任务在传：附件控件据此禁用自身（不禁用页面的其它写入口）。 */
  uploading: boolean;
  /** 选入文件：逐文件预检（大小/空文件/每次名额），超限的当场提示且不入队。 */
  addFiles: (files: readonly File[]) => void;
  /** 重试失败的任务（复用同一把幂等键）。 */
  retryUpload: (id: string) => void;
  /** 从队列移除（失败后放弃，或取消排队中的任务）。 */
  removeUpload: (id: string) => void;
  /** 取消进行中的上传：本地立即释放连接，服务端那次写入由待确认态接管。 */
  cancelUpload: (id: string) => void;
  /** 正在下载的附件 ID（同一时刻只允许一次下载）。 */
  downloadingId: string | null;
  download: (attachment: TicketAttachment) => void;
}

/** hook 内部的队列项：渲染投影之外的字段（文件、句柄、取消标记）都不进 state。 */
interface UploadTask {
  readonly id: string;
  readonly file: File;
  readonly holder: IdempotencyKeyHolder;
  status: TicketAttachmentUploadStatus;
  errorMessage?: string;
  controller: AbortController | null;
  cancelled: boolean;
}

/** 队列项的渲染投影。 */
function toUploadView(task: UploadTask): TicketAttachmentUpload {
  return {
    id: task.id,
    name: task.file.name,
    size: task.file.size,
    status: task.status,
    ...(task.errorMessage === undefined ? {} : { errorMessage: task.errorMessage }),
  };
}

/**
 * 附件编排层。
 *
 * `source` 是**依赖**而不是行为开关：控制台面与平台管理面共用同一套上传队列、并发调度、幂等键与失败分类，
 * 差别只在请求打到哪个协议面（见 `api/ticket-data-source`）。下载同理由数据源给出——管理面的凭据是
 * `Authorization` 头，取字节的通道本来就不同。
 */
export function useTicketAttachments(
  projectId: string,
  number: string,
  source: TicketDataSource,
  options: TicketAttachmentsOptions,
): TicketAttachmentsState {
  const { t, i18n } = useTranslation(TICKETS_NS);
  const language = i18n.language;
  const { onUncertain } = options;
  // 数据源的两个写/下载动作先解构出来：它们在 useCallback 里被引用，解构出的引用（而不是嵌套属性路径）
  // 既是稳定的，也能让依赖表如实列出真正被用到的那个函数。
  const { download: downloadAttachment, upload: uploadAttachment } = source.attachments;
  const [attachments, setAttachments] = useState<TicketAttachment[]>([]);
  const [uploads, setUploads] = useState<TicketAttachmentUpload[]>([]);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const tasksRef = useRef<UploadTask[]>([]);
  const activeRef = useRef(0);
  const downloadControllerRef = useRef<AbortController | null>(null);
  /** 调度器的最新实现：任务完成回调与选文件入口都经它补满并发，避免闭包陈旧。 */
  const pumpRef = useRef<() => void>(() => {});

  const syncUploads = useCallback(() => {
    setUploads(tasksRef.current.map(toUploadView));
  }, []);

  const list = useRequest(async () => unwrap(source.attachments.list(projectId, number)), {
    ready: options.enabled,
    refreshDeps: [projectId, number, options.enabled],
    onSuccess: (page) => {
      setAttachments(page.items);
    },
    onError: (err: Error) => {
      console.error("ticket attachments load failed", err);
      toast.error(err.message || t("attachment.loadFailed"));
    },
  });

  const dropTask = useCallback(
    (task: UploadTask) => {
      tasksRef.current = tasksRef.current.filter((candidate) => candidate !== task);
      syncUploads();
    },
    [syncUploads],
  );

  /** 单次上传：成功前插列表、202 上报、失败留在队列（幂等键的换代由失败分类决定）。 */
  const runTask = useCallback(
    async (task: UploadTask): Promise<void> => {
      task.controller = new AbortController();
      try {
        const result = await unwrap(
          uploadAttachment(
            projectId,
            number,
            task.file,
            // 内容指纹只含文件名与字节数：服务端的请求指纹同样只看这两项（内容是哈希，不是原件）。
            task.holder.take(writeSignature([task.file.name, String(task.file.size)])),
            task.controller.signal,
          ),
        );
        if (task.cancelled) return;
        if (isUncertainAccepted(result)) {
          dropTask(task);
          onUncertain(result.operationId);
          toast.success(t("attachment.accepted"));
          return;
        }
        task.holder.reset();
        dropTask(task);
        setAttachments((prev) => [
          result.attachment,
          ...prev.filter((item) => item.attachmentId !== result.attachment.attachmentId),
        ]);
        toast.success(t("attachment.uploaded"));
      } catch (error) {
        if (task.cancelled) return;
        settleTicketWriteFailure(error, {
          t,
          holder: task.holder,
          failureMessageKey: "attachment.uploadFailed",
          logLabel: "ticket attachment upload failed",
        });
        task.status = "failed";
        // 内联行给出服务端信封原文（拿到什么显示什么），通用失败由上面的分类负责 toast。
        task.errorMessage =
          error instanceof Error && error.message.length > 0 ? error.message : t("attachment.uploadFailed");
      } finally {
        task.controller = null;
        activeRef.current = Math.max(0, activeRef.current - 1);
        syncUploads();
        pumpRef.current();
      }
    },
    [dropTask, number, onUncertain, projectId, syncUploads, t, uploadAttachment],
  );

  /** 补满并发：从队首取 `queued` 的任务启动，直到达到并发上限或没有可启动的任务。 */
  const pump = useCallback((): void => {
    while (activeRef.current < TICKET_ATTACHMENT_CONCURRENCY) {
      const next = tasksRef.current.find((task) => task.status === "queued");
      if (next === undefined) return;
      next.status = "uploading";
      activeRef.current += 1;
      syncUploads();
      void runTask(next);
    }
  }, [runTask, syncUploads]);

  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  const addFiles = useCallback(
    (files: readonly File[]): void => {
      const plan = planTicketAttachmentSelection(files);
      const maxSize = formatAttachmentSize(TICKET_ATTACHMENT_MAX_BYTES, language);
      for (const rejection of plan.rejected) {
        toast.error(ticketAttachmentRejectionMessage(t, rejection.file, rejection.reason, maxSize));
      }
      if (plan.accepted.length === 0) return;
      for (const file of plan.accepted) {
        tasksRef.current.push({
          id: newIdempotencyKey(),
          file,
          holder: createIdempotencyKeyHolder(),
          status: "queued",
          controller: null,
          cancelled: false,
        });
      }
      syncUploads();
      pumpRef.current();
    },
    [language, syncUploads, t],
  );

  /** 取消所有在途与排队中的任务（换工单、卸载时调用）。 */
  const cancelAll = useCallback((): void => {
    for (const task of tasksRef.current) {
      task.cancelled = true;
      task.controller?.abort();
    }
    tasksRef.current = [];
    activeRef.current = 0;
    syncUploads();
  }, [syncUploads]);

  const retryUpload = useCallback(
    (id: string): void => {
      const task = tasksRef.current.find((candidate) => candidate.id === id);
      if (task === undefined || task.status !== "failed") return;
      task.status = "queued";
      task.errorMessage = undefined;
      syncUploads();
      pumpRef.current();
    },
    [syncUploads],
  );

  const removeUpload = useCallback(
    (id: string): void => {
      const task = tasksRef.current.find((candidate) => candidate.id === id);
      if (task === undefined) return;
      task.cancelled = true;
      task.controller?.abort();
      dropTask(task);
    },
    [dropTask],
  );

  const cancelUpload = removeUpload;

  const download = useCallback(
    (attachment: TicketAttachment): void => {
      // 同一时刻只允许一次下载：新请求取消旧请求（与文件树下载同一口径），避免两个落盘写同名文件。
      downloadControllerRef.current?.abort();
      const controller = new AbortController();
      downloadControllerRef.current = controller;
      setDownloadingId(attachment.attachmentId);
      void (async () => {
        try {
          const blob = await downloadAttachment(projectId, number, attachment.attachmentId, controller.signal);
          if (controller.signal.aborted) return;
          saveBlobAsFile(blob, attachment.name);
        } catch (error) {
          if (controller.signal.aborted) return;
          console.error("ticket attachment download failed", error);
          toast.error(
            error instanceof Error && error.message.length > 0 ? error.message : t("attachment.downloadFailed"),
          );
        } finally {
          if (downloadControllerRef.current === controller) {
            downloadControllerRef.current = null;
            setDownloadingId(null);
          }
        }
      })();
    },
    [downloadAttachment, number, projectId, t],
  );

  // 换工单：在途上传的坐标是旧工单，结果已无意义，一并取消并清空队列与列表。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 两个路由参数是刻意的重置触发信号，effect 体只用稳定回调。
  useEffect(() => {
    setAttachments([]);
    setUploads([]);
    setDownloadingId(null);
    return () => {
      cancelAll();
      downloadControllerRef.current?.abort();
    };
  }, [projectId, number, cancelAll]);

  return {
    attachments,
    loading: list.loading,
    error: list.error,
    retry: list.refresh,
    uploads,
    uploading: uploads.some((task) => task.status === "uploading"),
    addFiles,
    retryUpload,
    removeUpload,
    cancelUpload,
    downloadingId,
    download,
  };
}
