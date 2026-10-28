import { FormDialog } from "@fenix/ui-components/config/FormDialog";
import { Button } from "@fenix/ui-components/ui/button";
import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { Textarea } from "@fenix/ui-components/ui/textarea";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LangBotBot } from "../../../api/langbot";
import { parseBotConfigJson } from "../../../lib/channel-page-state";

/** 提交给父组件的字段；`config` 缺省表示编辑时保留 LangBot 上的原配置。 */
export interface BotFormValue {
  readonly name: string;
  readonly adapter: string;
  readonly config?: Record<string, unknown>;
}

interface SecretEntry {
  readonly id: string;
  readonly key: string;
  readonly value: string;
}

/** 密钥行只在本弹窗内需要稳定 key：删除中间一行时按索引复用会把值和输入框状态错配到别的行。 */
let nextSecretRowId = 0;

interface BotFormDialogProps {
  readonly open: boolean;
  readonly mode: "create" | "edit";
  /** 编辑模式的行；配置不会回显，只用于回填名称与适配器。 */
  readonly bot: LangBotBot | null;
  readonly saving: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (value: BotFormValue) => void;
}

/**
 * 创建 / 编辑 Bot 的弹窗。
 *
 * 后端不返回 `config`，因此编辑模式只回填名称与适配器、配置输入框保持空白：留空即保持 LangBot 原配置。
 * 创建模式额外提供 password 类型的「密钥字段」，提交时合并进配置对象——适配器凭据不必以明文写进 JSON。
 */
export function BotFormDialog(props: BotFormDialogProps) {
  const { t } = useTranslation(NS.CHANNELS);
  const { mode, bot } = props;
  const [name, setName] = useState(bot?.name ?? "");
  const [adapter, setAdapter] = useState(bot?.adapter ?? "");
  const [configText, setConfigText] = useState(mode === "create" ? "{}" : "");
  const [secrets, setSecrets] = useState<SecretEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    const trimmedName = name.trim();
    const trimmedAdapter = adapter.trim();
    if (!trimmedName) {
      setError(t("langbot.bots.form.nameRequired"));
      return;
    }
    if (!trimmedAdapter) {
      setError(t("langbot.bots.form.adapterRequired"));
      return;
    }

    const parsed = parseBotConfigJson(configText);
    if (!parsed.ok) {
      setError(
        t(
          parsed.reason === "syntax"
            ? "langbot.bots.form.configInvalidJson"
            : parsed.reason === "notObject"
              ? "langbot.bots.form.configNotObject"
              : "langbot.bots.form.configTooLarge",
        ),
      );
      return;
    }

    const config: Record<string, unknown> = { ...parsed.value };
    for (const entry of secrets) {
      const key = entry.key.trim();
      if (!key || !entry.value) {
        setError(t("langbot.bots.form.secretIncomplete"));
        return;
      }
      config[key] = entry.value;
    }

    const hasConfig = mode === "create" || configText.trim().length > 0 || secrets.length > 0;
    setError(null);
    props.onSubmit({
      name: trimmedName,
      adapter: trimmedAdapter,
      ...(hasConfig ? { config } : {}),
    });
  };

  return (
    <FormDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) setError(null);
        props.onOpenChange(open);
      }}
      title={t(mode === "create" ? "langbot.bots.form.createTitle" : "langbot.bots.form.editTitle")}
      onSubmit={handleSubmit}
      loading={props.saving}
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="channel-bot-name">{t("langbot.bots.form.name")}</Label>
          <Input
            id="channel-bot-name"
            className="mt-1"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("langbot.bots.form.namePlaceholder")}
            autoFocus
          />
        </div>

        <div>
          <Label htmlFor="channel-bot-adapter">{t("langbot.bots.form.adapter")}</Label>
          <Input
            id="channel-bot-adapter"
            className="mt-1"
            value={adapter}
            onChange={(event) => setAdapter(event.target.value)}
            placeholder={t("langbot.bots.form.adapterPlaceholder")}
          />
        </div>

        <div>
          <Label htmlFor="channel-bot-config">{t("langbot.bots.form.config")}</Label>
          <Textarea
            id="channel-bot-config"
            className="mt-1 min-h-32 font-mono text-xs"
            value={configText}
            onChange={(event) => setConfigText(event.target.value)}
            placeholder={t("langbot.bots.form.configPlaceholder")}
            spellCheck={false}
          />
          <p className="mt-1 text-xs text-text-dim">
            {t(mode === "create" ? "langbot.bots.form.configHint" : "langbot.bots.form.configEditHint")}
          </p>
        </div>

        {mode === "create" ? (
          <div className="space-y-2">
            <div>
              <p className="text-xs font-medium text-text-secondary">{t("langbot.bots.form.secretTitle")}</p>
              <p className="text-xs text-text-dim">{t("langbot.bots.form.secretHint")}</p>
            </div>
            {secrets.map((entry, index) => (
              <div key={entry.id} className="flex items-end gap-2">
                <Input
                  className="flex-1"
                  value={entry.key}
                  onChange={(event) =>
                    setSecrets((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, key: event.target.value } : item,
                      ),
                    )
                  }
                  placeholder={t("langbot.bots.form.secretKey")}
                  aria-label={t("langbot.bots.form.secretKey")}
                />
                <Input
                  className="flex-1"
                  type="password"
                  autoComplete="new-password"
                  value={entry.value}
                  onChange={(event) =>
                    setSecrets((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, value: event.target.value } : item,
                      ),
                    )
                  }
                  placeholder={t("langbot.bots.form.secretValue")}
                  aria-label={t("langbot.bots.form.secretValue")}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setSecrets((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                  aria-label={t("langbot.bots.form.removeSecret")}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setSecrets((current) => [...current, { id: `secret-${nextSecretRowId++}`, key: "", value: "" }])
              }
            >
              <Plus />
              {t("langbot.bots.form.addSecret")}
            </Button>
          </div>
        ) : null}

        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </FormDialog>
  );
}
