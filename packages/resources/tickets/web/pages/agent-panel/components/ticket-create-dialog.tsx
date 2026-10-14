/**
 * 创建工单弹窗：标题 + 描述两个字段、zod 校验、幂等键与 201/202 分流，以及附件的两段式提交。
 *
 * 分工：**本组件只负责表单与写请求**，跳转、成功/受理提示、列表刷新都由页面经回调决定——201 要跳详情、
 * 202 要留在列表并挂持久提示，两种结局的动作完全不同，写在页面里才有唯一的一处「创建之后发生什么」。
 *
 * 幂等键：`createIdempotencyKeyHolder()` 在组件挂载期内持有，提交时按表单内容指纹取键。同内容重试
 * （网络超时后用户再点一次「创建」）复用同一个键，服务端据此返回原操作而不是重复建单；内容改了才换代
 *（同键不同内容会被服务端按 `IDEMPOTENCY_CONFLICT` 拒绝）。键不在域模块里生成——那样每次调用都是新键，
 * 服务端的去重账本永远命中不了同一个操作。
 *
 * **附件的两段式提交**：附件上传以工单号为坐标（`/web/tickets/:projectId/:number/attachments`），创建
 * 成功前没有落点，因此粘贴/选择进来的文件先暂存在弹窗（`useTicketStagedAttachments`），201 拿到工单号后
 * 才进入上传阶段（`TicketCreateUploadStage`），全部附件终结后才关闭弹窗并进入工单。202 时工单号可能不
 * 存在，暂存的附件没有落点——明确提示未上传，而不是静默丢弃（用户以为传了、详情页却没有）。
 *
 * 弹窗重置靠**父级的 `key`**（父级每次打开换一个 key，整棵子树重挂）：`FormDialog` 内部在自身组件体里
 * 建 `useForm`，只改 `open` 不会重建表单实例，上一次的输入会留在下一次打开时。
 *
 * 长度上限与后端同源（标题 200 字符、正文 64 KiB）：正文那条在前端按 **JS 字符串长度**计，是粗略预检——
 * 服务端量的是拼上身份头之后的 UTF-8 字节数，客户端不复制那套计算，超限最终仍由服务端拒绝。
 */

import { FormDialog, type FormDialogFormConfig } from "@fenix/ui-components/config/FormDialog";
import { LabeledField } from "@fenix/ui-components/config/LabeledField";
import { Button } from "@fenix/ui-components/ui/button";
import { Input } from "@fenix/ui-components/ui/input";
import { Textarea } from "@fenix/ui-components/ui/textarea";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { X } from "lucide-react";
import { type ClipboardEvent, useCallback, useMemo, useState } from "react";
import { useFormContext } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod/v4";
import type { TicketDetail } from "../../../api/tickets";
import { ticketApi } from "../../../api/tickets";
import { type TicketStagedFile, useTicketStagedAttachments } from "../../../hooks/use-ticket-create-attachments";
import { TICKETS_NS } from "../../../i18n/namespace";
import {
  formatAttachmentSize,
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_ATTACHMENT_MAX_COUNT,
} from "../../../lib/ticket-attachment-limits";
import { readPastedImageFiles, renamePastedImage } from "../../../lib/ticket-clipboard-images";
import {
  createIdempotencyKeyHolder,
  isUncertainAccepted,
  ticketFormSignature,
} from "../../../lib/ticket-write-outcome";
import { FieldError } from "./field-error";
import { TicketAttachmentPicker } from "./ticket-attachment-section";
import { TicketCreateUploadStage } from "./ticket-create-upload-stage";

/** 标题上限（字符），与后端 `TICKET_TITLE_MAX_LENGTH` 一致。 */
const TICKET_TITLE_MAX_CHARS = 200;

/** 正文上限（字符）：后端 `MESSAGE_MAX_BYTES` 是 64 KiB 字节，这里是粗粒度预检。 */
const TICKET_BODY_MAX_CHARS = 64 * 1024;

/**
 * 创建表单校验。**schema 里放的是 i18n 键、不是文案**：错误行经 `FieldError` 的 `t(messageKey)` 取值，
 * 带中文 message 会让文案绕过 `t()`、也不再随语言切换。
 *
 * `body` 与后端 `TicketCreateRequestSchema` 同为必填（`min(1)`）：空描述在前端就被挡下，用户拿到的
 * 是「请填写描述」而不是一次必然 400 的往返。
 */
export const ticketFormSchema = z.object({
  title: z.string().trim().min(1, "validation.titleRequired").max(TICKET_TITLE_MAX_CHARS, "validation.titleMax"),
  body: z.string().min(1, "validation.bodyRequired").max(TICKET_BODY_MAX_CHARS, "validation.bodyMax"),
});

export type TicketFormValues = z.infer<typeof ticketFormSchema>;

export interface TicketCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 创建落点。页面只在「已开通且默认项目可用」时渲染本组件，因此这里收到的一定是可用项目 ID。 */
  projectId: string;
  /** 201：工单已建，页面负责成功提示、刷新与跳转详情。 */
  onCreated: (ticket: TicketDetail) => void;
  /** 202：上游写入结果未定，页面负责「提交结果确认中」提示与刷新（不跳转、不显示成功）。 */
  onAccepted: () => void;
}

export function TicketCreateDialog({ open, onOpenChange, projectId, onCreated, onAccepted }: TicketCreateDialogProps) {
  const { t } = useTranslation(TICKETS_NS);
  const idempotency = useMemo(() => createIdempotencyKeyHolder(), []);
  const stagedAttachments = useTicketStagedAttachments();
  /** 创建成功后的工单（非空即进入上传阶段）：附件全部终结后关闭弹窗并进入该工单。 */
  const [created, setCreated] = useState<TicketDetail | null>(null);

  const create = useRequest(
    async (values: TicketFormValues) =>
      unwrap(
        ticketApi.create(
          projectId,
          { title: values.title, body: values.body },
          idempotency.take(ticketFormSignature(values)),
        ),
      ),
    {
      manual: true,
      onSuccess: (result) => {
        if (isUncertainAccepted(result)) {
          // 202：工单号未知（上游可能已建也可能没有），暂存的附件没有落点。提示而不是丢弃——用户会
          // 预期「附件随工单一起提交」，静默消失只会让他在详情页里找不到东西。
          if (stagedAttachments.staged.length > 0) toast.warning(t("create.attachmentsNotUploaded"));
          onOpenChange(false);
          onAccepted();
          return;
        }
        if (stagedAttachments.staged.length === 0) {
          // 无附件：沿用原有路径——关闭弹窗，由页面跳转详情。
          onOpenChange(false);
          onCreated(result.ticket);
          return;
        }
        // 有附件：不立即关闭，改由上传阶段接管（表单折叠、弹窗不可关闭），全部附件终结后才进入工单。
        setCreated(result.ticket);
      },
      onError: (error: Error) => {
        // 服务端 `message` 优先上屏（含唯一键冲突这类可定位的原因），字典文案只在它是空串时兜底。
        console.error("ticket create failed", error);
        toast.error(error.message || t("toast.createFailed"));
      },
    },
  );

  const finishUpload = useCallback(() => {
    const ticket = created;
    if (ticket === null) return;
    // 先撤掉上传阶段（`created` 归位）再走页面回调：只关 `open` 不会卸载它——它持有自己的 Dialog 与
    // 上传队列，留着会让「完成之后」的界面依赖页面跳转来收尾（跳转失败就是永远开着）。
    setCreated(null);
    onOpenChange(false);
    onCreated(ticket);
  }, [created, onCreated, onOpenChange]);

  const formConfig = useMemo<FormDialogFormConfig>(
    () => ({
      mode: "onSubmit",
      // `FormDialog` 的 schema/onFormSubmit 形参是 `Record<string, unknown>`（组件库为兼容任意表单形状的
      // 收口），此处按本表单的值类型收窄——与 `@fenix/resource-task` 的 `AgentTasksPage` 同款边界写法。
      schema: ticketFormSchema as unknown as z.ZodType<Record<string, unknown>>,
      defaultValues: { title: "", body: "" },
      onFormSubmit: (data) => create.run(data as unknown as TicketFormValues),
    }),
    [create.run],
  );

  if (created !== null) {
    return (
      <TicketCreateUploadStage
        files={stagedAttachments.staged.map((item) => item.file)}
        number={created.issueNumber}
        onFinished={finishUpload}
        projectId={created.projectId}
      />
    );
  }

  return (
    <FormDialog
      formConfig={formConfig}
      loading={create.loading}
      onOpenChange={onOpenChange}
      open={open}
      title={t("create.title")}
      width="sm:max-w-xl"
    >
      <TicketCreateFields
        disabled={create.loading}
        onAddFiles={stagedAttachments.addFiles}
        onRemoveFile={stagedAttachments.removeFile}
        staged={stagedAttachments.staged}
      />
    </FormDialog>
  );
}

interface TicketCreateFieldsProps {
  /** 提交进行中：字段与附件入口一并冻结，避免请求带上用户来不及看到的改动、或改动暂存列表。 */
  disabled: boolean;
  staged: readonly TicketStagedFile[];
  onAddFiles: (files: readonly File[]) => void;
  onRemoveFile: (id: string) => void;
}

/**
 * 字段与附件入口的渲染：`useFormContext` 取 `FormDialog` 内部的 form 实例，因此必须渲染在它的 FormProvider 下。
 *
 * 粘贴与「添加附件」是同一个暂存列表的两个入口（与详情页评论框同构）：粘贴只识别图片、纯文本与普通文件
 * 保持浏览器默认行为；改名（带时间戳的唯一名）在粘贴入口处完成，理由见 `lib/ticket-clipboard-images.ts`。
 *
 * **导出供用例直接渲染**：本块本身不含覆盖层，而它所在的 Radix 弹窗在同进程测试运行时不挂载（见
 * `agent-ticket-write-actions.test.tsx` 文件头），粘贴-暂存这条最核心的用户动线只能绕开弹窗外壳验证。
 */
export function TicketCreateFields({ disabled, staged, onAddFiles, onRemoveFile }: TicketCreateFieldsProps) {
  const { t } = useTranslation(TICKETS_NS);
  const { register, formState } = useFormContext<TicketFormValues>();

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = readPastedImageFiles(event.clipboardData);
    if (files.length === 0) return;
    // 剪贴板里同时有文本与图片（从网页复制图文）时只取图片：文本进去也无法表达「这段文字原本带图」。
    event.preventDefault();
    onAddFiles(files.map((file) => renamePastedImage(file)));
  };

  return (
    <div className="grid gap-4">
      <div>
        <LabeledField label={t("create.titleLabel")}>
          <Input
            aria-invalid={formState.errors.title ? true : undefined}
            disabled={disabled}
            placeholder={t("create.titlePlaceholder")}
            {...register("title")}
          />
        </LabeledField>
        <FieldError messageKey={formState.errors.title?.message} />
      </div>
      <div>
        <LabeledField label={t("create.bodyLabel")}>
          <Textarea
            aria-invalid={formState.errors.body ? true : undefined}
            className="min-h-32"
            disabled={disabled}
            onPaste={handlePaste}
            placeholder={t("create.bodyPlaceholder")}
            {...register("body")}
          />
        </LabeledField>
        <FieldError messageKey={formState.errors.body?.message} />
      </div>
      <TicketStagedAttachments disabled={disabled} files={staged} onAddFiles={onAddFiles} onRemoveFile={onRemoveFile} />
    </div>
  );
}

interface TicketStagedAttachmentsProps {
  disabled: boolean;
  files: readonly TicketStagedFile[];
  onAddFiles: (files: readonly File[]) => void;
  onRemoveFile: (id: string) => void;
}

/** 暂存附件区：待上传列表（名称、大小、移除）＋「添加附件」入口与组合规则提示。 */
function TicketStagedAttachments({ disabled, files, onAddFiles, onRemoveFile }: TicketStagedAttachmentsProps) {
  const { t, i18n } = useTranslation(TICKETS_NS);
  const hint = t("create.attachmentHint", {
    size: formatAttachmentSize(TICKET_ATTACHMENT_MAX_BYTES, i18n.language),
    max: TICKET_ATTACHMENT_MAX_COUNT,
  });

  return (
    <div className="flex flex-col gap-2">
      {files.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {files.map((item) => (
            <li
              className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2"
              key={item.id}
            >
              <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{item.file.name}</span>
              <span className="text-xs text-text-dim">{formatAttachmentSize(item.file.size, i18n.language)}</span>
              <Button
                aria-label={t("attachment.remove")}
                disabled={disabled}
                onClick={() => onRemoveFile(item.id)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <TicketAttachmentPicker disabled={disabled} onSelect={onAddFiles} />
        <span className="text-xs text-text-dim">{hint}</span>
      </div>
    </div>
  );
}
