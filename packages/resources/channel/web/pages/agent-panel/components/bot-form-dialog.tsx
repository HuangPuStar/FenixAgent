import { FormDialog } from "@fenix/ui-components/config/FormDialog";
import { cn } from "@fenix/ui-components/lib/cn";
import { Button } from "@fenix/ui-components/ui/button";
import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@fenix/ui-components/ui/select";
import { Switch } from "@fenix/ui-components/ui/switch";
import { Textarea } from "@fenix/ui-components/ui/textarea";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LangBotBot } from "../../../api/langbot";
import { parseBotConfigJson } from "../../../lib/channel-page-state";
import {
  BUILTIN_ADAPTERS,
  booleanFieldValue,
  buildAdapterConfig,
  CUSTOM_ADAPTER_ID,
  findBuiltinAdapter,
} from "./adapter-catalog";
import { AdapterIcon } from "./adapter-icons";

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

/** 适配器网格的选项：内置目录 + 自定义（插件适配器）。 */
const ADAPTER_ENTRIES = [
  ...BUILTIN_ADAPTERS.map(({ id, labelKey }) => ({ id, labelKey })),
  { id: CUSTOM_ADAPTER_ID, labelKey: "langbot.bots.adapters.custom" },
];

/** 文本与布尔共用一个状态表；取文本值时把布尔值视为空。 */
function textFieldValue(values: Readonly<Record<string, string | boolean>>, key: string): string {
  const value = values[key];
  return typeof value === "string" ? value : "";
}

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
 * 适配器以图标卡片网格展示，点击选中后按目录渲染各自的字段；插件适配器只能手填 ID 与 JSON 配置。
 * 后端不返回 `config`，所以编辑模式下字段一律留空：留空即保留 LangBot 上的原配置。
 */
export function BotFormDialog(props: BotFormDialogProps) {
  const { t } = useTranslation(NS.CHANNELS);
  const { mode, bot } = props;
  const initialAdapter = bot?.adapter ?? "";
  const initialBuiltin = findBuiltinAdapter(initialAdapter);
  const [name, setName] = useState(bot?.name ?? "");
  const [adapterChoice, setAdapterChoice] = useState(initialBuiltin?.id ?? (initialAdapter ? CUSTOM_ADAPTER_ID : ""));
  const [customAdapter, setCustomAdapter] = useState(initialBuiltin ? "" : initialAdapter);
  const [fieldValues, setFieldValues] = useState<Record<string, string | boolean>>({});
  const [configText, setConfigText] = useState(mode === "create" ? "{}" : "");
  const [secrets, setSecrets] = useState<SecretEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const definition = adapterChoice === CUSTOM_ADAPTER_ID ? undefined : findBuiltinAdapter(adapterChoice);

  const handleSubmit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("langbot.bots.form.nameRequired"));
      return;
    }

    const adapter = adapterChoice === CUSTOM_ADAPTER_ID ? customAdapter.trim() : adapterChoice;
    if (!adapter) {
      setError(t("langbot.bots.form.adapterRequired"));
      return;
    }

    let config: Record<string, unknown>;
    if (definition) {
      const built = buildAdapterConfig(definition, fieldValues);
      if (mode === "create" && built.missing.length > 0) {
        setError(
          t("langbot.bots.form.fieldRequired", {
            field: t(built.missing[0]!.labelKey),
          }),
        );
        return;
      }
      config = built.config;
    } else {
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
      config = { ...parsed.value };
      for (const entry of secrets) {
        const key = entry.key.trim();
        if (!key || !entry.value) {
          setError(t("langbot.bots.form.secretIncomplete"));
          return;
        }
        config[key] = entry.value;
      }
    }

    const hasConfig = mode === "create" || Object.keys(config).length > 0;
    setError(null);
    props.onSubmit({
      name: trimmedName,
      adapter,
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
          <Label id="channel-bot-adapter-label">{t("langbot.bots.form.adapter")}</Label>
          <div
            role="group"
            aria-labelledby="channel-bot-adapter-label"
            className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3"
          >
            {ADAPTER_ENTRIES.map(({ id, labelKey }) => {
              const selected = adapterChoice === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    setAdapterChoice(id);
                    setError(null);
                  }}
                  className={cn(
                    "flex flex-col items-center justify-center gap-1 rounded-md border px-2 py-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    selected
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "border-border hover:border-primary/40",
                  )}
                >
                  <AdapterIcon adapter={id} className="size-5" />
                  <span className="text-center leading-tight">{t(labelKey)}</span>
                </button>
              );
            })}
          </div>
        </div>

        {definition ? (
          <div className="space-y-3">
            {definition.fields
              .filter((field) => !field.implicit)
              .map((field) => {
                const fieldId = `channel-bot-field-${field.key}`;
                if (field.kind === "boolean") {
                  return (
                    <div key={field.key} className="flex items-center justify-between gap-3">
                      <Label htmlFor={fieldId}>{t(field.labelKey)}</Label>
                      <Switch
                        id={fieldId}
                        checked={booleanFieldValue(field, fieldValues)}
                        onCheckedChange={(checked) =>
                          setFieldValues((current) => ({ ...current, [field.key]: checked }))
                        }
                      />
                    </div>
                  );
                }
                return (
                  <div key={field.key}>
                    <Label htmlFor={fieldId}>
                      {t(field.labelKey)}
                      {field.required ? <span className="ml-0.5 text-destructive">*</span> : null}
                    </Label>
                    {field.kind === "select" ? (
                      <Select
                        value={
                          textFieldValue(fieldValues, field.key) ||
                          (typeof field.defaultValue === "string" ? field.defaultValue : "")
                        }
                        onValueChange={(value) => setFieldValues((current) => ({ ...current, [field.key]: value }))}
                      >
                        <SelectTrigger id={fieldId} className="mt-1 w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(field.options ?? []).map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {t(option.labelKey)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id={fieldId}
                        className="mt-1"
                        type={field.kind === "secret" ? "password" : "text"}
                        autoComplete={field.kind === "secret" ? "new-password" : "off"}
                        value={textFieldValue(fieldValues, field.key)}
                        onChange={(event) =>
                          setFieldValues((current) => ({ ...current, [field.key]: event.target.value }))
                        }
                      />
                    )}
                  </div>
                );
              })}
          </div>
        ) : null}

        {adapterChoice === CUSTOM_ADAPTER_ID ? (
          <div className="space-y-3">
            <div>
              <Label htmlFor="channel-bot-custom-adapter">{t("langbot.bots.form.customAdapter")}</Label>
              <Input
                id="channel-bot-custom-adapter"
                className="mt-1"
                value={customAdapter}
                onChange={(event) => setCustomAdapter(event.target.value)}
                placeholder={t("langbot.bots.form.customAdapterPlaceholder")}
              />
              <p className="mt-1 text-xs text-text-dim">{t("langbot.bots.form.customHint")}</p>
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
