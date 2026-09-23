// AgentSiteForm.tsx — 「新建 / 编辑应用」弹窗的字段体（§4.3 的 FormDialog + formConfig 形态）。
//
// 字段值不落在页面 state 里：`FormDialog` 内部创建 `useForm`，表单实例的生命周期由调用方的 `key` 控制，
// 本组件只经 `useFormContext()` 绑定字段。此前这段字段 JSX 直接写在页面上，配合三个 `useState` 与一条
// 写在请求体构造里的校验（`if (!name.trim()) throw new Error(...)`）——那条错误会被 `useRequest` 的
// `onError` 接成通用的「保存应用失败」toast，用户看不到「名称不能为空」这个真正的原因。

import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@fenix/ui-components/ui/select";
import { Textarea } from "@fenix/ui-components/ui/textarea";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useFormContext } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod/v4";
import type { SiteApp } from "../../../api/sites";

/** 提交给后端的三个字段；`description` 可留空，`visibility` 取后端枚举。 */
export interface AgentSiteFormValues {
  name: string;
  description: string;
  visibility: SiteApp["visibility"];
}

/**
 * 字段校验：只描述「什么样的取值合法」，**不携带文案**——错误文案在视图边界按字段取 i18n 键
 * （与同目录 `agentEditorSchema` 同口径）。带中文 `message` 会让文案绕过 `t()`（§9.1）。
 */
export const agentSiteFormSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string(),
  visibility: z.enum(["private", "org", "authenticated", "public"]),
});

const VISIBILITIES = ["private", "org", "authenticated", "public"] as const;

export function AgentSiteForm() {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const {
    register,
    setValue,
    watch,
    formState: { errors },
  } = useFormContext<AgentSiteFormValues>();
  // `visibility` 走 Radix `Select`（非原生控件），拿不到 `register` 的 ref，用受控值 + `setValue`
  // 接回表单实例。
  const visibility = watch("visibility");

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="site-name">{t("siteDeployment.form.name")}</Label>
        <Input
          id="site-name"
          placeholder={t("siteDeployment.form.namePlaceholder")}
          {...register("name")}
          aria-invalid={errors.name ? true : undefined}
        />
        {errors.name ? (
          <p className="text-xs text-destructive" role="alert">
            {t("siteDeployment.errors.nameRequired")}
          </p>
        ) : null}
      </div>
      <div className="grid gap-2">
        <Label htmlFor="site-description">{t("siteDeployment.form.description")}</Label>
        <Textarea
          id="site-description"
          rows={3}
          placeholder={t("siteDeployment.form.descriptionPlaceholder")}
          {...register("description")}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="site-visibility">{t("siteDeployment.visibility.label")}</Label>
        <Select
          value={visibility}
          onValueChange={(value) =>
            setValue("visibility", value as AgentSiteFormValues["visibility"], { shouldValidate: true })
          }
        >
          <SelectTrigger id="site-visibility">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VISIBILITIES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`siteDeployment.visibility.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
