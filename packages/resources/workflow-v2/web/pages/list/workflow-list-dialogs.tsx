// pages/list/workflow-list-dialogs.tsx
// 列表页的三个弹窗：新建、重命名、删除确认（§4.2 的「弹窗状态由页面持有、弹窗只收目标对象与回调」）。
//
// 「初始化工作流空间」**不在本文件**：它改为一键动作（点击即调 `POST /org-app`，无入参、无表单），弹窗形态
// 已随名称输入框一起删除——包一个只有「确认」的弹窗会让用户以为还需要做决定，而这件事没有任何可决定的内容
// （名称由服务端取组织名称）。失败提示由页面的提示条给出。
//
// 表单形态遵循 §4.3：`FormDialog` 内部创建 `useForm`，字段体经 `useFormContext()` 绑定，校验用 zod
// （`zod/v4`，本包依赖），schema **只描述合不合法、不带文案**——错误文案在字段体里按字段取 i18n 键，
// 带 message 的 schema 会让文案绕过 `t()`（§9.1）。
//
// 表单重置走 `key`：调用方的打开计数变化即重挂载 `FormDialog`，因此「关掉再开」不会带回上一次的输入，
// 不需要 `onOpenChange` 里手工清字段（§4.3）。
//
// `react-hook-form` 经 `@fenix/ui-components/config/FormDialog` 传递进入（与 channel / plugin-market 的
// 字段体同款取用），本包 `package.json` 不新增依赖。

import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { FormDialog } from "@fenix/ui-components/config/FormDialog";
import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { Textarea } from "@fenix/ui-components/ui/textarea";
import { useFormContext } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod/v4";
import type { WorkflowV2WorkflowItem } from "../../api/workflows";
import { WORKFLOW_NS } from "../../i18n/namespace";

/** 新建表单值；`desc` 可留空（服务端 `desc` 可选，空串由调用点折叠成 undefined）。 */
export interface WorkflowCreateFormValues {
  name: string;
  desc: string;
}

/** 重命名表单值：本页只改名称，`desc` / `iconUri` 留给画布内的元数据编辑。 */
export interface WorkflowRenameFormValues {
  name: string;
}

/** 名称列的服务端约束（`CreateWorkflowBodySchema`：`trim().min(1).max(200)`），前端同名同限避免白跑一次请求。 */
const WORKFLOW_NAME_SCHEMA = z.string().trim().min(1).max(200);

export const workflowCreateFormSchema = z.object({ name: WORKFLOW_NAME_SCHEMA, desc: z.string().max(2000) });
export const workflowRenameFormSchema = z.object({ name: WORKFLOW_NAME_SCHEMA });

/** 新建弹窗的字段体（字段值由 `FormDialog` 的 `useForm` 持有，这里只绑定）。 */
function WorkflowCreateFields() {
  const { t } = useTranslation(WORKFLOW_NS);
  const {
    register,
    formState: { errors },
  } = useFormContext<WorkflowCreateFormValues>();

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="workflow-create-name">{t("list.name_label")}</Label>
        <Input
          id="workflow-create-name"
          autoComplete="off"
          placeholder={t("list.name_placeholder")}
          aria-invalid={errors.name ? true : undefined}
          {...register("name")}
        />
        {errors.name ? (
          <p className="text-xs text-destructive" role="alert">
            {t("list.form.name_invalid")}
          </p>
        ) : null}
      </div>
      <div className="grid gap-2">
        <Label htmlFor="workflow-create-desc">{t("list.desc_label")}</Label>
        <Textarea
          id="workflow-create-desc"
          rows={3}
          placeholder={t("list.desc_placeholder")}
          aria-invalid={errors.desc ? true : undefined}
          {...register("desc")}
        />
        {errors.desc ? (
          <p className="text-xs text-destructive" role="alert">
            {t("list.form.desc_too_long")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** 重命名弹窗的字段体；默认值是**打开时**的名称，重挂载后即最新目标（§4.3 的 key 重置）。 */
function WorkflowRenameFields() {
  const { t } = useTranslation(WORKFLOW_NS);
  const {
    register,
    formState: { errors },
  } = useFormContext<WorkflowRenameFormValues>();

  return (
    <div className="grid gap-2">
      <Label htmlFor="workflow-rename-name">{t("list.name_label")}</Label>
      <Input
        id="workflow-rename-name"
        autoComplete="off"
        aria-invalid={errors.name ? true : undefined}
        {...register("name")}
      />
      {errors.name ? (
        <p className="text-xs text-destructive" role="alert">
          {t("list.form.name_invalid")}
        </p>
      ) : null}
    </div>
  );
}

/** 提交失败时的行内提示位（`FormDialog` 没有错误槽位，失败也不该关掉弹窗把输入丢掉）。 */
function DialogError({ text }: { readonly text: string | null }) {
  if (text === null) return null;
  return (
    <p className="text-xs text-destructive" role="alert">
      {text}
    </p>
  );
}

export interface WorkflowCreateDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (values: WorkflowCreateFormValues) => void;
  readonly loading: boolean;
  /** 每次打开由页面递增：变化即重挂载表单，回到空白（§4.3）。 */
  readonly formKey: number;
  /** 上一次提交失败的文案；重新打开或再次提交时由页面清空。 */
  readonly errorText: string | null;
}

export function WorkflowCreateDialog({
  open,
  onOpenChange,
  onSubmit,
  loading,
  formKey,
  errorText,
}: WorkflowCreateDialogProps) {
  const { t } = useTranslation(WORKFLOW_NS);
  return (
    <FormDialog
      key={formKey}
      open={open}
      onOpenChange={onOpenChange}
      title={t("list.create_title")}
      submitLabel={t("list.create_submit")}
      cancelLabel={t("list.cancel")}
      loading={loading}
      formConfig={{
        schema: workflowCreateFormSchema as z.ZodType<Record<string, unknown>>,
        defaultValues: { name: "", desc: "" } as unknown as Record<string, unknown>,
        onFormSubmit: (values) => onSubmit(values as unknown as WorkflowCreateFormValues),
      }}
    >
      <div className="grid gap-3">
        <WorkflowCreateFields />
        <DialogError text={errorText} />
      </div>
    </FormDialog>
  );
}

export interface WorkflowRenameDialogProps {
  /** 目标记录；为 null 表示关闭（弹窗状态由页面持有，§4.2）。 */
  readonly target: WorkflowV2WorkflowItem | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (values: WorkflowRenameFormValues) => void;
  readonly loading: boolean;
  readonly formKey: number;
  readonly errorText: string | null;
}

export function WorkflowRenameDialog({
  target,
  onOpenChange,
  onSubmit,
  loading,
  formKey,
  errorText,
}: WorkflowRenameDialogProps) {
  const { t } = useTranslation(WORKFLOW_NS);
  return (
    <FormDialog
      key={`${target?.id ?? "none"}-${formKey}`}
      open={target !== null}
      onOpenChange={onOpenChange}
      title={t("list.rename_title")}
      submitLabel={t("list.rename_submit")}
      cancelLabel={t("list.cancel")}
      loading={loading}
      formConfig={{
        schema: workflowRenameFormSchema as z.ZodType<Record<string, unknown>>,
        // 默认值取打开时的名称；表单实例随 key 每次新建，所以这里读到的一定是本次目标。
        defaultValues: { name: target?.name ?? "" } as unknown as Record<string, unknown>,
        onFormSubmit: (values) => onSubmit(values as unknown as WorkflowRenameFormValues),
      }}
    >
      <div className="grid gap-3">
        <WorkflowRenameFields />
        <DialogError text={errorText} />
      </div>
    </FormDialog>
  );
}

export interface WorkflowDeleteDialogProps {
  readonly target: WorkflowV2WorkflowItem | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
  readonly loading: boolean;
}

/**
 * 删除确认。文案不预告结果：删除是否被上游策略接受只有请求回来才知道，拒绝原因由页面的提示条给出
 * （弹窗在这里已经关闭）——把「可能失败」写进确认文案只会让正常删除看起来可疑。
 */
export function WorkflowDeleteDialog({ target, onOpenChange, onConfirm, loading }: WorkflowDeleteDialogProps) {
  const { t } = useTranslation(WORKFLOW_NS);
  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title={t("list.delete_confirm_title")}
      description={t("list.delete_confirm", { name: target?.name ?? "" })}
      confirmLabel={t("list.delete")}
      cancelLabel={t("list.cancel")}
      variant="destructive"
      loading={loading}
      onConfirm={onConfirm}
    />
  );
}
