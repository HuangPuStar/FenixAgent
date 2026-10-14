/**
 * 标题/描述编辑弹窗：两个字段**一次 PATCH** 提交。
 *
 * 为什么两个字段必须同一次请求：它们参与同一份内容指纹，拆成两次会产生一个中间版本，并让第二笔请求的
 * `expectedVersion` 立刻过期——那是拿确定的失败换一个没必要的「字段级」提交粒度。
 *
 * 关闭时机是本组件唯一的状态机：只有 `applied` 才关。**202 要留在弹窗上**（用户需要看到「提交结果确认中」
 * 的横幅，而不是以为保存成功了），**409 冲突要留着草稿与提示**（`FormDialog` 不会自己关闭，这正是它能
 * 承载「失败后不丢输入」的前提）。
 *
 * 表单默认值取自打开那一刻的工单，之后不再跟随刷新变化（刷新是用户在冲突提示里显式点的，他改到一半的
 * 输入不该被替换）；提交时的 `expectedVersion` 由写路径现取，因此「打开时的快照过期」不会造成误判冲突。
 */

import { FormDialog, type FormDialogFormConfig } from "@fenix/ui-components/config/FormDialog";
import { LabeledField } from "@fenix/ui-components/config/LabeledField";
import { Input } from "@fenix/ui-components/ui/input";
import { Textarea } from "@fenix/ui-components/ui/textarea";
import { useMemo } from "react";
import { useFormContext } from "react-hook-form";
import { useTranslation } from "react-i18next";
import type { z } from "zod/v4";
import type { TicketDetail } from "../../../api/tickets";
import { TICKETS_NS } from "../../../i18n/namespace";
import type { TicketWriteOutcome } from "../../../lib/ticket-write-outcome";
import { FieldError } from "./field-error";
import { TicketConflictNotice } from "./ticket-conflict-notice";
import type { TicketFormValues } from "./ticket-create-dialog";
import { ticketFormSchema } from "./ticket-create-dialog";

export interface TicketFieldsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 打开弹窗时对应的工单快照：只用于取初值。 */
  ticket: TicketDetail;
  onSubmit: (values: TicketFormValues) => Promise<TicketWriteOutcome>;
  submitting: boolean;
  /** 409 冲突：内联提示 + 手动「加载最新内容」。 */
  conflict: boolean;
  onReload: () => void;
  reloading: boolean;
  disabled: boolean;
}

export function TicketFieldsDialog({
  open,
  onOpenChange,
  ticket,
  onSubmit,
  submitting,
  conflict,
  onReload,
  reloading,
  disabled,
}: TicketFieldsDialogProps) {
  const { t } = useTranslation(TICKETS_NS);

  const formConfig = useMemo<FormDialogFormConfig>(
    () => ({
      mode: "onSubmit",
      // 与创建表单同一份 schema（标题 200 字符、描述 64 KiB）：编辑没有额外的字段规则，多一份副本只会分叉。
      schema: ticketFormSchema as unknown as z.ZodType<Record<string, unknown>>,
      defaultValues: { title: ticket.title, body: ticket.body },
      onFormSubmit: (data) => {
        void (async () => {
          const outcome = await onSubmit(data as unknown as TicketFormValues);
          // 只有真正生效才关：202 要留在弹窗上看「确认中」，冲突要留着草稿让用户刷新后重提。
          if (outcome === "applied") onOpenChange(false);
        })();
      },
    }),
    [onOpenChange, onSubmit, ticket.body, ticket.title],
  );

  return (
    <FormDialog
      disabled={disabled}
      formConfig={formConfig}
      loading={submitting}
      onOpenChange={onOpenChange}
      open={open}
      title={t("edit.title")}
      width="sm:max-w-xl"
    >
      <div className="grid gap-4">
        {conflict ? <TicketConflictNotice onReload={onReload} reloading={reloading} /> : null}
        <TicketFields />
      </div>
    </FormDialog>
  );
}

/** 两个字段的渲染：`useFormContext` 取 `FormDialog` 内部的 form 实例，必须渲染在它的 FormProvider 下。 */
function TicketFields() {
  const { t } = useTranslation(TICKETS_NS);
  const { register, formState } = useFormContext<TicketFormValues>();
  return (
    <>
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
    </>
  );
}
