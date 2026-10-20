/**
 * 新建工单弹窗的附件编排：表单阶段的「暂存」（`useTicketStagedAttachments`）与创建成功后的「上传移交」
 * （`useTicketUploadHandoff`）。
 *
 * 为什么不能像详情页那样「选入即上传」：附件上传以工单号为坐标（`/web/tickets/:projectId/:number/attachments`），
 * 新建弹窗在创建成功前没有坐标，文件只能先留在本地；创建成功后（拿到工单号）才移交给上传队列。上传队列
 * 本身仍由 `useTicketAttachments` 承担（预检、并发、幂等键、失败分类全部复用），本模块只负责详情页没有的
 * 一段时序：「何时移交」与「何时算全部终结」。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { webTicketDataSource } from "../api/ticket-data-source";
import { TICKETS_NS } from "../i18n/namespace";
import {
  formatAttachmentSize,
  planTicketAttachmentSelection,
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_ATTACHMENT_MAX_COUNT,
  ticketAttachmentRejectionMessage,
} from "../lib/ticket-attachment-limits";
import { newIdempotencyKey } from "../lib/ticket-write-outcome";
import { type TicketAttachmentUpload, useTicketAttachments } from "./use-ticket-attachments";

/** 暂存文件：`id` 供列表 key 与移除定位，`file` 是入口处已改名的拷本（粘贴图片的名字在读取时生成）。 */
export interface TicketStagedFile {
  readonly id: string;
  readonly file: File;
}

export interface TicketStagedAttachmentsState {
  /** 待上传列表（按选入顺序累积）。 */
  readonly staged: TicketStagedFile[];
  /** 选入 / 粘贴的文件：预检（大小、空文件、每次名额）拒绝的当场提示且不入列。 */
  readonly addFiles: (files: readonly File[]) => void;
  /** 从暂存列表移除（放弃该文件，不会产生任何请求）。 */
  readonly removeFile: (id: string) => void;
}

/**
 * 表单阶段的暂存列表。
 *
 * 预检口径与详情页附件队列一致（`planTicketAttachmentSelection` + 同一份拒绝文案）：同一个文件在两个入口
 * 不该得到不同的结论。行 id 用 `newIdempotencyKey()`（随机 UUID）而不用数组下标：移除中间项时下标 key
 * 会让 React 复用错行。
 */
export function useTicketStagedAttachments(): TicketStagedAttachmentsState {
  const { t, i18n } = useTranslation(TICKETS_NS);
  const [staged, setStaged] = useState<TicketStagedFile[]>([]);

  const addFiles = useCallback(
    (files: readonly File[]) => {
      const plan = planTicketAttachmentSelection(files);
      const maxSize = formatAttachmentSize(TICKET_ATTACHMENT_MAX_BYTES, i18n.language);
      for (const rejection of plan.rejected) {
        toast.error(ticketAttachmentRejectionMessage(t, rejection.file, rejection.reason, maxSize));
      }
      if (plan.accepted.length === 0) return;
      setStaged((prev) => [...prev, ...plan.accepted.map((file) => ({ id: newIdempotencyKey(), file }))]);
    },
    [i18n.language, t],
  );

  const removeFile = useCallback((id: string) => {
    setStaged((prev) => prev.filter((item) => item.id !== id));
  }, []);

  return { staged, addFiles, removeFile };
}

export interface TicketUploadHandoffOptions {
  readonly projectId: string;
  /** 创建成功后拿到的工单号：上传请求的坐标。 */
  readonly number: string;
  /** 已改名的暂存文件（阶段组件的生命周期内引用不变）。 */
  readonly files: readonly File[];
  /** 全部任务终结（上传成功 / 受理未定 / 失败被移除）后回调一次。 */
  readonly onFinished: () => void;
}

export interface TicketUploadHandoffState {
  /** 未终结与失败的上传任务（成功与受理的任务已移出队列）。 */
  readonly uploads: readonly TicketAttachmentUpload[];
  readonly retryUpload: (id: string) => void;
  readonly removeUpload: (id: string) => void;
  readonly cancelUpload: (id: string) => void;
}

/**
 * 上传阶段的编排：挂载即把暂存文件移交上传队列，全部终结后回调一次。
 *
 * 移交放在**挂载 effect** 而不是「创建成功」的回调里：回调执行时本组件还停留在旧坐标（`number` 为空串），
 * 此时入队的任务会把请求打到空工单号上；挂载 effect 读到的才是以真实坐标渲染后的调度器。
 *
 * **不设「已移交」守卫**：StrictMode 会重放挂载 effect，而 `useTicketAttachments` 的挂载清理会取消上一轮
 * 任务并清空队列——守卫会让重放后的队列空着，用户看到「全部上传成功」而附件实际什么都没传。无守卫则
 * 重放后重新入队，功能正确（代价只是 dev 下可能重复一次上传，生产没有重放）。
 */
export function useTicketUploadHandoff({
  files,
  number,
  onFinished,
  projectId,
}: TicketUploadHandoffOptions): TicketUploadHandoffState {
  // 新建工单只存在于控制台面（管理面不创建工单），数据源固定为 `/web` 面。
  const attachments = useTicketAttachments(projectId, number, webTicketDataSource, {
    // 弹窗不渲染已上传列表（列表回源上游、渲染在详情页），因此不请求列表。
    enabled: false,
    // 附件上传 202：hook 已 toast「结果确认中」并把任务移出队列；详情页的待确认横幅只由工单级变更
    // （issue.update / issue.labels）驱动，附件操作不在其中，弹窗这侧没有可上报的容器。
    onUncertain: ignoreUncertain,
  });

  /** 完成判定的闸门：见下方判定 effect 的注释。 */
  const armedRef = useRef(false);
  /** 只在终结时回调一次：判定 effect 会在后续渲染中继续运行。 */
  const finishedRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 移交只发生在挂载（files 是阶段生命周期内的稳定输入）。
  useEffect(() => {
    if (files.length === 0) {
      // 没有文件可移交：直接终结（正常路径不会渲染本阶段，这里防的是误用造成的死等）。
      onFinished();
      return;
    }
    // 分批移交：预检按「每次选择」计数，暂存列表可以跨多次选择累积，单批超过上限会被拒掉一部分。
    for (let index = 0; index < files.length; index += TICKET_ATTACHMENT_MAX_COUNT) {
      attachments.addFiles(files.slice(index, index + TICKET_ATTACHMENT_MAX_COUNT));
    }
  }, []);

  useEffect(() => {
    if (attachments.uploads.length > 0) {
      // 先见非空才武装：挂载 effect 与判定 effect 在同一次提交里先后执行，入队触发的重渲染还没发生，
      // 此时 uploads 仍是空数组——不设闸门会把「刚移交」当场判成「已全部终结」。
      armedRef.current = true;
      return;
    }
    if (!armedRef.current || finishedRef.current) return;
    finishedRef.current = true;
    onFinished();
  }, [attachments.uploads, onFinished]);

  return {
    uploads: attachments.uploads,
    retryUpload: attachments.retryUpload,
    removeUpload: attachments.removeUpload,
    cancelUpload: attachments.cancelUpload,
  };
}

/** 附件上传 202 的占位处理（理由见 `useTicketUploadHandoff`）：必须是稳定引用，避免 hook 每次渲染换回调。 */
function ignoreUncertain(): void {}
