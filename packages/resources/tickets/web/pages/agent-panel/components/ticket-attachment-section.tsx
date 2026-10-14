/**
 * 附件的三个视图：选择入口（给评论输入框用）、附件区（队列 + 已上传列表）与上传队列列表。
 *
 * **为什么上传入口在评论框、附件列表却在评论区上方**：附件挂在工单上（上游端点以工单号为坐标），不是挂在
 * 某条评论上。用户的心智是「写评论时顺手带个截图」，因此入口贴着输入框；而列表若不与评论分开，读者会以为
 * 附件属于紧邻的那条评论。两者共享同一个 `useTicketAttachments` 实例（由详情页装配），组件本身保持纯受控：
 * 组件不持有第二份队列状态——双份状态必然在取消/重试两条路径上分叉。
 *
 * 上传队列列表（`TicketAttachmentUploadList`）另有一个消费者：新建弹窗「创建成功后上传」阶段的队列。
 * 该场景不渲染已上传列表（列表回源上游、落在详情页），因此队列与列表是两个可独立复用的视图。
 *
 * 文件类型不做前端白名单：托管平台的白名单是权威（扩展名不在白名单时服务端 400 并给出原因），前端抢先
 * 过滤只会把「为什么这个文件选不了」变成一处没有文案的静默。
 *
 * 图片附件的缩略图与放大预览由 `ticket-attachment-preview.tsx` 负责，列表行只决定「这一行要不要渲染缩略图」：
 * 行内不额外取图，缩略图直接复用该行的下载地址。
 */

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { AlertTriangle, Download, Loader2, Paperclip, RefreshCw, RotateCw, X } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { type TicketAttachment, ticketAttachmentDownloadPath } from "../../../api/ticket-attachments";
import type { TicketAttachmentsState, TicketAttachmentUpload } from "../../../hooks/use-ticket-attachments";
import { TICKETS_NS } from "../../../i18n/namespace";
import {
  formatAttachmentSize,
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_ATTACHMENT_MAX_COUNT,
} from "../../../lib/ticket-attachment-limits";
import { isImageAttachmentName, TicketAttachmentThumb } from "./ticket-attachment-preview";
import { formatTicketTime } from "./ticket-format";

export interface TicketAttachmentPickerProps {
  /** 有任务在传时禁用自身，避免同一个文件被连点两次。 */
  disabled: boolean;
  onSelect: (files: File[]) => void;
}

/** 「添加附件」按钮 + 隐藏的文件输入。选中的文件交给调用方的预检与队列。 */
export function TicketAttachmentPicker({ disabled, onSelect }: TicketAttachmentPickerProps) {
  const { t } = useTranslation(TICKETS_NS);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        aria-hidden="true"
        className="hidden"
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // 先清空 input 的值：同一个文件连选两次（第一次失败后重试）也要能再次触发 change。
          event.target.value = "";
          if (files.length > 0) onSelect(files);
        }}
        ref={inputRef}
        tabIndex={-1}
        type="file"
      />
      <Button disabled={disabled} onClick={() => inputRef.current?.click()} size="sm" type="button" variant="outline">
        <Paperclip className="size-3.5" />
        {t("attachment.add")}
      </Button>
    </>
  );
}

export interface TicketAttachmentSectionProps {
  attachments: TicketAttachmentsState;
  /** 当前界面语言，用于时间与文件大小格式化。 */
  locale: string;
  /** 详情页路由坐标：缩略图要拼本服务的下载地址（组件不自行读路由，保持可独立渲染）。 */
  number: string;
  projectId: string;
  /**
   * 缩略图与放大预览的图源。默认拼控制台面的 `/web` 下载地址（同源、浏览器自带会话 cookie）。
   *
   * 平台管理面必须覆盖它：那里的凭据是 `Authorization` 头，`<img src>` 带不上，给缩略图另造一条
   * 「先 fetch 成 blob 再 objectURL」的通道要多一份手工释放的生命周期，而它只影响预览——附件行与
   * 下载按钮都不依赖它（下载走带凭据的 `Blob`）。返回 `undefined` 即不渲染缩略图。
   */
  thumbnailUrlFor?: (attachmentId: string) => string | undefined;
  /**
   * 「打开附件」入口。传了就**文件名本身变成按钮**（键盘可达、读屏可读），点击交给调用方决定语义：
   * 平台管理面用它做「图片预览 / 其余下载」（那里的图源要带 `Authorization` 取字节，见
   * `web/pages/admin/hooks/use-platform-attachment-preview.ts`）。省略即文件名保持纯文本（控制台面：
   * 预览入口在缩略图上，下载入口在行尾按钮）。
   */
  onOpen?: (attachment: TicketAttachment) => void;
}

/** 工单附件区：上传队列（过程）+ 已上传列表（结果），四个状态分支齐备。 */
export function TicketAttachmentSection({
  attachments,
  locale,
  number,
  projectId,
  thumbnailUrlFor = (attachmentId) => ticketAttachmentDownloadPath(projectId, number, attachmentId),
  onOpen,
}: TicketAttachmentSectionProps) {
  const { t } = useTranslation(TICKETS_NS);
  const hint = t("attachment.hint", {
    size: formatAttachmentSize(TICKET_ATTACHMENT_MAX_BYTES, locale),
    max: TICKET_ATTACHMENT_MAX_COUNT,
  });

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-medium text-text-primary">{t("attachment.sectionTitle")}</h2>
        <span className="text-xs text-text-dim">{hint}</span>
      </div>

      {attachments.uploads.length === 0 ? null : (
        <div className="mt-3">
          <TicketAttachmentUploadList
            locale={locale}
            onCancel={attachments.cancelUpload}
            onRemove={attachments.removeUpload}
            onRetry={attachments.retryUpload}
            uploads={attachments.uploads}
          />
        </div>
      )}

      {attachments.loading ? (
        <div className="mt-3 flex flex-col gap-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : attachments.error !== undefined ? (
        <EmptyState
          action={{
            label: t("loadState.retry"),
            icon: <RefreshCw className="size-3.5" />,
            onClick: attachments.retry,
          }}
          description={attachments.error.message || t("attachment.loadFailed")}
          icon={<AlertTriangle className="size-6" />}
          role="alert"
          title={t("attachment.loadFailed")}
          tone="danger"
        />
      ) : attachments.attachments.length === 0 ? (
        <p className="mt-3 text-xs text-text-dim">{t("attachment.empty")}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {attachments.attachments.map((attachment) => (
            <AttachmentRow
              attachment={attachment}
              downloadUrl={thumbnailUrlFor(attachment.attachmentId)}
              downloading={attachments.downloadingId === attachment.attachmentId}
              key={attachment.attachmentId}
              locale={locale}
              onDownload={() => attachments.download(attachment)}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export interface TicketAttachmentUploadListProps {
  uploads: readonly TicketAttachmentUpload[];
  /** 当前界面语言，用于文件大小格式化。 */
  locale: string;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}

/**
 * 上传队列列表（过程态）：详情页附件区与新建弹窗的上传阶段共用同一份渲染与动作语义——「取消 / 重试 /
 * 移除」的含义与可用条件只有一处定义。空队列渲染为 `null`，调用方不必再写「有没有队列」的条件。
 */
export function TicketAttachmentUploadList({
  uploads,
  locale,
  onCancel,
  onRetry,
  onRemove,
}: TicketAttachmentUploadListProps) {
  if (uploads.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {uploads.map((task) => (
        <UploadRow
          key={task.id}
          locale={locale}
          onCancel={() => onCancel(task.id)}
          onRemove={() => onRemove(task.id)}
          onRetry={() => onRetry(task.id)}
          task={task}
        />
      ))}
    </ul>
  );
}

/** 队列行：状态文案与可用动作由状态决定（上传中可取消、失败可重试或移除）。 */
function UploadRow({
  task,
  locale,
  onCancel,
  onRetry,
  onRemove,
}: {
  task: TicketAttachmentUpload;
  locale: string;
  onCancel: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation(TICKETS_NS);
  const failed = task.status === "failed";
  const statusText = failed
    ? (task.errorMessage ?? t("attachment.uploadFailed"))
    : task.status === "uploading"
      ? t("attachment.uploading")
      : t("attachment.queued");

  return (
    <li
      className={
        failed
          ? "flex flex-wrap items-center gap-2 rounded-md border border-status-error/40 bg-surface-1 px-3 py-2"
          : "flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2"
      }
    >
      {failed ? (
        <AlertTriangle className="size-3.5 shrink-0 text-status-error" />
      ) : (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-text-dim" />
      )}
      <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{task.name}</span>
      <span className="text-xs text-text-dim">{formatAttachmentSize(task.size, locale)}</span>
      <span
        className={failed ? "text-xs text-status-error" : "text-xs text-text-dim"}
        role={failed ? "alert" : "status"}
      >
        {statusText}
      </span>
      {failed ? (
        <>
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            <RotateCw className="size-3.5" />
            {t("attachment.retry")}
          </Button>
          <Button aria-label={t("attachment.remove")} onClick={onRemove} size="sm" type="button" variant="ghost">
            <X className="size-3.5" />
          </Button>
        </>
      ) : (
        <Button onClick={onCancel} size="sm" type="button" variant="ghost">
          {t("attachment.cancel")}
        </Button>
      )}
    </li>
  );
}

/** 列表行：图片附件带缩略图，其余为名称、大小、时间与下载按钮（下载中禁用并显示转圈）。 */
function AttachmentRow({
  attachment,
  downloadUrl,
  locale,
  downloading,
  onDownload,
  onOpen,
}: {
  attachment: TicketAttachment;
  /** 缩略图的图源；`undefined` 表示这个面取不到可内联的地址（管理面），此时不渲染缩略图。 */
  downloadUrl: string | undefined;
  locale: string;
  downloading: boolean;
  onDownload: () => void;
  onOpen?: (attachment: TicketAttachment) => void;
}) {
  const { t } = useTranslation(TICKETS_NS);

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2">
      {downloadUrl !== undefined && isImageAttachmentName(attachment.name) ? (
        <TicketAttachmentThumb name={attachment.name} url={downloadUrl} />
      ) : null}
      <span className="min-w-0 flex-1 truncate text-xs text-text-primary">
        {onOpen === undefined ? (
          attachment.name
        ) : (
          <button
            aria-label={t("attachment.open", { name: attachment.name })}
            className="max-w-full truncate text-left text-brand hover:underline"
            onClick={() => onOpen(attachment)}
            type="button"
          >
            {attachment.name}
          </button>
        )}
      </span>
      <span className="text-xs text-text-dim">{formatAttachmentSize(attachment.size, locale)}</span>
      <span className="text-xs text-text-dim">{formatTicketTime(attachment.createdAt, locale)}</span>
      <Button disabled={downloading} onClick={onDownload} size="sm" type="button" variant="outline">
        {downloading ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
        {t("attachment.download")}
      </Button>
    </li>
  );
}
