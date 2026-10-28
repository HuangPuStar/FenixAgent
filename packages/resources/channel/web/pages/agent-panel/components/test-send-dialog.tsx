import { FormDialog } from "@fenix/ui-components/config/FormDialog";
import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { Textarea } from "@fenix/ui-components/ui/textarea";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LangBotBot, LangBotChatType, LangBotTestSendInput } from "../../../api/langbot";

interface TestSendDialogProps {
  readonly open: boolean;
  readonly bot: LangBotBot | null;
  readonly sending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (value: LangBotTestSendInput) => void;
}

/** 测试发送弹窗：只调 LangBot `send_message`，不写入平台事件或会话。 */
export function TestSendDialog(props: TestSendDialogProps) {
  const { t } = useTranslation(NS.CHANNELS);
  const [targetType, setTargetType] = useState<LangBotChatType>("person");
  const [targetId, setTargetId] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    const trimmedTarget = targetId.trim();
    if (!trimmedTarget || !text.trim()) {
      setError(t("langbot.bots.test.required"));
      return;
    }
    setError(null);
    props.onSubmit({ targetType, targetId: trimmedTarget, text });
  };

  return (
    <FormDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) setError(null);
        props.onOpenChange(open);
      }}
      title={t("langbot.bots.test.title")}
      submitLabel={t("langbot.bots.test.submit")}
      onSubmit={handleSubmit}
      loading={props.sending}
      disabled={!props.bot?.botUuid}
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="channel-send-target-type">{t("langbot.bots.test.targetType")}</Label>
          <select
            id="channel-send-target-type"
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={targetType}
            onChange={(event) => setTargetType(event.target.value === "group" ? "group" : "person")}
          >
            <option value="person">{t("langbot.bots.test.person")}</option>
            <option value="group">{t("langbot.bots.test.group")}</option>
          </select>
        </div>

        <div>
          <Label htmlFor="channel-send-target-id">{t("langbot.bots.test.targetId")}</Label>
          <Input
            id="channel-send-target-id"
            className="mt-1"
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            placeholder={t("langbot.bots.test.targetIdPlaceholder")}
          />
        </div>

        <div>
          <Label htmlFor="channel-send-text">{t("langbot.bots.test.text")}</Label>
          <Textarea
            id="channel-send-text"
            className="mt-1 min-h-24"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("langbot.bots.test.textPlaceholder")}
          />
        </div>

        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </FormDialog>
  );
}
