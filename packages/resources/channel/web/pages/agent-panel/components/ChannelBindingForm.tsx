// ChannelBindingForm.tsx — 「新建通道绑定」弹窗的字段体（§4.3 的 FormDialog + formConfig 形态）。
//
// 字段值不落在页面 state 里：`FormDialog` 内部创建 `useForm`，表单实例的生命周期由调用方的 `key` 控制，
// 本组件只经 `useFormContext()` 绑定字段。此前这段字段 JSX 直接写在页面上，配合三个 `useState` 与
// 一段手写校验（`if (!formPlatform.trim() || !formAgentId) toast.error(...)`）——必填缺失只在右下角飘一条
// toast，字段本身没有任何标记，用户看不出是哪个输入没填。

import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@fenix/ui-components/ui/select";
import { useFormContext } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod/v4";

/** 提交给后端的三个字段；`chatId` 允许留空（后端按「匹配该平台全部消息」处理）。 */
export interface ChannelBindingFormValues {
  platform: string;
  chatId: string;
  agentId: string;
}

/**
 * 字段校验：只描述「什么样的取值合法」，**不携带文案**——错误文案在视图边界按字段取 i18n 键
 * （与 agent-config 的 `agentEditorSchema` 同口径）。带中文 `message` 会让文案绕过 `t()`（§9.1），
 * 译文也就没法随语言切换。
 */
export const channelBindingFormSchema = z.object({
  platform: z.string().trim().min(1),
  chatId: z.string(),
  agentId: z.string().trim().min(1),
});

interface ChannelBindingFormProps {
  /** 可绑定的环境（Agent）候选，由页面在取数成功后传入。 */
  environments: { id: string; name: string }[];
}

export function ChannelBindingForm({ environments }: ChannelBindingFormProps) {
  const { t } = useTranslation("channels");
  const {
    register,
    setValue,
    watch,
    formState: { errors },
  } = useFormContext<ChannelBindingFormValues>();
  // `agentId` 走 Radix `Select`（非原生控件），拿不到 `register` 的 ref，用受控值 + `setValue`
  // 接回表单实例。
  const agentId = watch("agentId");

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="channel-binding-platform">{t("dialog.platform")}</Label>
        <Input
          id="channel-binding-platform"
          className="mt-1"
          placeholder={t("dialog.platformPlaceholder")}
          {...register("platform")}
        />
        {errors.platform ? (
          <p className="mt-1 text-xs text-destructive" role="alert">
            {t("dialog.platformRequired")}
          </p>
        ) : null}
      </div>
      <div>
        <Label htmlFor="channel-binding-chat-id">{t("dialog.chatId")}</Label>
        <Input id="channel-binding-chat-id" className="mt-1" {...register("chatId")} />
      </div>
      <div>
        <Label htmlFor="channel-binding-agent">{t("dialog.agent")}</Label>
        <Select value={agentId} onValueChange={(value) => setValue("agentId", value, { shouldValidate: true })}>
          <SelectTrigger id="channel-binding-agent" className="mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {environments.map((env) => (
              <SelectItem key={env.id} value={env.id}>
                {env.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors.agentId ? (
          <p className="mt-1 text-xs text-destructive" role="alert">
            {t("dialog.agentRequired")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
