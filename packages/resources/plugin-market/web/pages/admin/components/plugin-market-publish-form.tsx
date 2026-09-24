// plugin-market-publish-form.tsx — 发布弹窗的字段体（§4.3 的 `FormDialog` + `formConfig` 形态）。
//
// 字段值不落在弹窗 state 里：`FormDialog` 内部创建 `useForm`，表单实例的生命周期由调用方的 `key` 控制
// （容器每次打开自增 `key`），本组件只经 `useFormContext()` 绑定字段。此前两个输入框由弹窗自己的
// `useState` 持有，必填校验是一段手写规则、错误只能落在弹窗底部的一条通用提示里——字段本身没有任何标记，
// 用户看不出是哪个输入没填。
//
// **schema 不携带文案**：它只描述「什么样的取值合法」，错误文案在视图边界按字段取 i18n 键（与
// `channelBindingFormSchema` / `agentEditorSchema` 同口径）。带中文 `message` 会让文案绕过 `t()`（§9.1），
// 译文也就没法随语言切换。

import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { useFormContext } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod/v4";
import { PLUGIN_MARKET_NS } from "../../../i18n/namespace";

/** 发布目标的两个定位符：私有源上的包名与精确版本。 */
export interface PluginPublishFormValues {
  packageName: string;
  exactVersion: string;
}

/**
 * 两个字段都只判非空（`.trim()` 顺带把取值规整掉，提交函数不必再 `trim`）。
 *
 * 格式校验有意留空：包名的 scope 形态与版本的 SemVer 合法性都由私有源上的实际内容说了算——本地先拦一道
 * 只会挡住合法输入（如私有源接受的非标准版本号），而市场真正要防的是「空值提交」。
 */
export const pluginPublishFormSchema = z.object({
  packageName: z.string().trim().min(1),
  exactVersion: z.string().trim().min(1),
});

interface PluginPublishFormProps {
  /**
   * 已有预览时锁定字段：此时「确认发布」确认的是**预览那一份**的定位符，不是输入框的当前内容。
   * 放开输入会让界面展示 A、实际发布 B（`runPublish` 取的是预览自带的取值）。
   */
  locked: boolean;
}

/** 字段体：两个文本框 + 各自的字段级必填提示。 */
export function PluginPublishForm({ locked }: PluginPublishFormProps) {
  const { t } = useTranslation(PLUGIN_MARKET_NS);
  const {
    register,
    formState: { errors },
  } = useFormContext<PluginPublishFormValues>();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Label htmlFor="plugin-market-publish-package-name">{t("dialog.packageName")}</Label>
        <Input
          id="plugin-market-publish-package-name"
          className="mt-1 font-mono text-sm"
          placeholder={t("dialog.packageNamePlaceholder")}
          autoComplete="off"
          disabled={locked}
          {...register("packageName")}
        />
        {errors.packageName ? (
          <p className="mt-1 text-xs text-destructive" role="alert">
            {t("validation.packageNameRequired")}
          </p>
        ) : null}
      </div>

      <div>
        <Label htmlFor="plugin-market-publish-exact-version">{t("dialog.exactVersion")}</Label>
        <Input
          id="plugin-market-publish-exact-version"
          className="mt-1 font-mono text-sm"
          placeholder={t("dialog.exactVersionPlaceholder")}
          autoComplete="off"
          disabled={locked}
          {...register("exactVersion")}
        />
        {errors.exactVersion ? (
          <p className="mt-1 text-xs text-destructive" role="alert">
            {t("validation.exactVersionRequired")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
