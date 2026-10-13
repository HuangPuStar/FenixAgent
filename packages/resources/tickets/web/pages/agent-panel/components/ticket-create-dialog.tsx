/**
 * 创建工单弹窗：标题 + 描述两个字段、zod 校验、幂等键与 201/202 分流。
 *
 * 分工：**本组件只负责表单与写请求**，跳转、成功/受理提示、列表刷新都由页面经回调决定——201 要跳详情、
 * 202 要留在列表并挂持久提示，两种结局的动作完全不同，写在页面里才有唯一的一处「创建之后发生什么」。
 *
 * 幂等键：`createIdempotencyKeyHolder()` 在组件挂载期内持有，提交时按表单内容指纹取键。同内容重试
 * （网络超时后用户再点一次「创建」）复用同一个键，服务端据此返回原操作而不是重复建单；内容改了才换代
 *（同键不同内容会被服务端按 `IDEMPOTENCY_CONFLICT` 拒绝）。键不在域模块里生成——那样每次调用都是新键，
 * 服务端的去重账本永远命中不了同一个操作。
 *
 * 弹窗重置靠**父级的 `key`**（父级每次打开换一个 key，整棵子树重挂）：`FormDialog` 内部在自身组件体里
 * 建 `useForm`，只改 `open` 不会重建表单实例，上一次的输入会留在下一次打开时。
 *
 * 长度上限与后端同源（标题 200 字符、正文 64 KiB）：正文那条在前端按 **JS 字符串长度**计，是粗略预检——
 * 服务端量的是拼上身份头之后的 UTF-8 字节数，客户端不复制那套计算，超限最终仍由服务端拒绝。
 */

import { FormDialog, type FormDialogFormConfig } from "@fenix/ui-components/config/FormDialog";
import { LabeledField } from "@fenix/ui-components/config/LabeledField";
import { Input } from "@fenix/ui-components/ui/input";
import { Textarea } from "@fenix/ui-components/ui/textarea";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { useMemo } from "react";
import { useFormContext } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod/v4";
import type { TicketDetail } from "../../../api/tickets";
import { ticketApi } from "../../../api/tickets";
import { TICKETS_NS } from "../../../i18n/namespace";
import {
  createIdempotencyKeyHolder,
  isUncertainAccepted,
  ticketFormSignature,
} from "../../../lib/ticket-write-outcome";
import { FieldError } from "./field-error";

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
        // 两种结局都要关弹窗：`onOpenChange(false)` 在这里而不是两个回调里，避免页面漏掉一边。
        onOpenChange(false);
        if (isUncertainAccepted(result)) {
          onAccepted();
          return;
        }
        onCreated(result.ticket);
      },
      onError: (error: Error) => {
        // 服务端 `message` 优先上屏（含唯一键冲突这类可定位的原因），字典文案只在它是空串时兜底。
        console.error("ticket create failed", error);
        toast.error(error.message || t("toast.createFailed"));
      },
    },
  );

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

  return (
    <FormDialog
      formConfig={formConfig}
      loading={create.loading}
      onOpenChange={onOpenChange}
      open={open}
      title={t("create.title")}
      width="sm:max-w-xl"
    >
      <TicketCreateFields />
    </FormDialog>
  );
}

/** 两个字段的渲染：`useFormContext` 取 `FormDialog` 内部的 form 实例，因此必须渲染在它的 FormProvider 下。 */
function TicketCreateFields() {
  const { t } = useTranslation(TICKETS_NS);
  const { register, formState } = useFormContext<TicketFormValues>();
  return (
    <div className="grid gap-4">
      <div>
        <LabeledField label={t("create.titleLabel")}>
          <Input
            aria-invalid={formState.errors.title ? true : undefined}
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
            placeholder={t("create.bodyPlaceholder")}
            {...register("body")}
          />
        </LabeledField>
        <FieldError messageKey={formState.errors.body?.message} />
      </div>
    </div>
  );
}
