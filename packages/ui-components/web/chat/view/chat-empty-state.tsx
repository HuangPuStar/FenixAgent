import { ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";

/** 空状态默认品牌图（宿主 public 资源路径，与源实现一致）。 */
const DEFAULT_EMPTY_LOGO_SRC = `${import.meta.env.BASE_URL}brand/fenix-agent-logo-mark.png`;

/**
 * 会话空状态：品牌图 + 标题 + 说明 + 三条建议提示词。
 *
 * 从 `ChatView.tsx` 拆出（单文件 ≤500 行）：建议提示词经 `onApplySuggestedPrompt` 回调，
 * 不再使用 window 自定义事件；品牌图地址可覆盖。
 */
export function ChatEmptyState({
  title,
  description,
  agentName,
  logoSrc = DEFAULT_EMPTY_LOGO_SRC,
  onApplySuggestedPrompt,
}: {
  title: string;
  description: string;
  agentName?: string;
  logoSrc?: string;
  onApplySuggestedPrompt?: (prompt: string) => void;
}) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const suggestions = [
    t("chat.components.chatEmpty.suggestionReview"),
    t("chat.components.chatEmpty.suggestionPlan"),
    t("chat.components.chatEmpty.suggestionBuild"),
  ];

  return (
    <section
      className="flex min-h-0 flex-1 flex-col items-center justify-center p-10 text-center max-sm:px-2 max-sm:py-7"
      data-slot="chat-empty-state"
      aria-labelledby="chat-empty-title"
    >
      <span
        className="grid h-11.5 w-11.5 rotate-[-5deg] place-items-center rounded-2xl border border-violet-200 bg-white text-blue-600"
        aria-hidden="true"
      >
        <img className="h-6.75 w-6.75 rotate-[5deg] object-contain" src={logoSrc} alt="" />
      </span>
      <small className="mt-4.5 text-blue-600 tracking-widest uppercase [font:700_11px_ui-monospace,monospace]">
        {agentName
          ? t("chat.components.chatEmpty.readyWithAgent", { agentName })
          : t("chat.components.chatEmpty.eyebrow")}
      </small>
      <h2
        id="chat-empty-title"
        className="chat-empty-heading my-1.75 text-3xl font-medium tracking-tight text-slate-800 max-sm:text-2xl"
      >
        {title}
      </h2>
      <p className="m-0 max-w-115 text-sm leading-relaxed text-slate-500">{description}</p>
      <div className="chat-empty-prompt-list mt-6 grid gap-2" data-slot="chat-empty-suggestions">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="chat-empty-prompt-button flex min-w-0 cursor-pointer items-center justify-between gap-4 rounded-lg border border-zinc-200 bg-white px-3.5 py-2.75 text-left text-xs text-gray-600 [transition:border-color_150ms_ease,box-shadow_150ms_ease,transform_150ms_ease] hover:-translate-y-px hover:border-indigo-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            onClick={() => onApplySuggestedPrompt?.(suggestion)}
          >
            <span>{suggestion}</span>
            <ArrowUpRight className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}
