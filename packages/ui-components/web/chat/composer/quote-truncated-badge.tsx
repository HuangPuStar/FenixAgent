import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";

/**
 * 引用被截断时的溢出提示（引用预览尾部的 `small`）。
 *
 * 2026-09-22 库内去重：`chat/composer/composer-assets.tsx` 的引用悬浮预览与
 * `chat/view/ChatQuoteMessage.tsx` 的已发送引用投影此前各写了一份逐字相同的
 * `{omittedCharacterCount > 0 && <small className="…">…}</small>`，文案键
 * （`chat.components.composerAssets.quoteTruncatedBadge`）与插值参数也相同，故收敛到此。
 *
 * 判空从调用方移进组件（不传或非正数时不渲染），渲染结果与逐字写法一致。
 * 类名逐字保留（含 `text-[10px]` / `text-[#8a5b16]` 两个既有任意值写法），未做 token 化。
 */
export function QuoteTruncatedBadge({ omittedCharacterCount }: { omittedCharacterCount: number }) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  if (omittedCharacterCount <= 0) return null;
  return (
    <small className="mt-1 block text-[10px] text-[#8a5b16]">
      {t("chat.components.composerAssets.quoteTruncatedBadge", { count: omittedCharacterCount })}
    </small>
  );
}
