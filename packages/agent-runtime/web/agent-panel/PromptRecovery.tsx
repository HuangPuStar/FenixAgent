import { Button } from "@fenix/ui-components/ui/button";
import { useTranslation } from "react-i18next";
import { AGENT_CHAT_NS } from "../i18n/namespace";
import type { PreservedPrompt } from "./chat-panel-runtime-types";

/** 输入恢复由用户确认目标；结果未知时仅提示核对，避免重复副作用。 */
export function PromptRecovery({
  prompt,
  retry,
  dismiss,
  disabled,
}: {
  prompt: PreservedPrompt;
  retry: () => void;
  dismiss: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation(AGENT_CHAT_NS);
  return (
    <div role="status" className="mx-4 mt-3 rounded-md border p-3 text-sm">
      <p>{prompt.outcomeUnknown ? t("promptRecoveryUnknown") : t("promptRecoverySaved")}</p>
      <div className="mt-2 flex gap-2">
        {!prompt.outcomeUnknown && (
          <Button size="sm" disabled={disabled} onClick={retry}>
            {t("promptRecoverySendCurrent")}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={dismiss}>
          {t("promptRecoveryDiscard")}
        </Button>
      </div>
    </div>
  );
}
