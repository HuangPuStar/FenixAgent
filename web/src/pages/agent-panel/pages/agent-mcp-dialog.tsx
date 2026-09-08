import { useRequest } from "ahooks";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FormDialog } from "@/components/config/FormDialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { mcpApi } from "@/src/api/mcp";
import { unwrap } from "@/src/api/request";
import { NS } from "../../../i18n";
import { canWriteMcp, getMcpLookupKey } from "../../../lib/mcp-resource-access";
import type { McpServerInfo } from "../../../types/config";
import {
  buildMcpPayload,
  type KeyValueEntry,
  McpImportError,
  parseMcpJson,
  stringifyMcpCommand,
  validateMcpEditor,
} from "./agent-mcp-utils";

export type McpEditorTarget = "create" | McpServerInfo | null;

type FormState = {
  name: string;
  type: "local" | "remote";
  command: string;
  url: string;
  environment: KeyValueEntry[];
  headers: KeyValueEntry[];
  timeout: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScope: string;
  oauthRedirectUri: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  type: "remote",
  command: "",
  url: "",
  environment: [{ key: "", value: "" }],
  headers: [{ key: "", value: "" }],
  timeout: "",
  oauthClientId: "",
  oauthClientSecret: "",
  oauthScope: "",
  oauthRedirectUri: "",
};

export function AgentMcpDialog({ target, onClose, onSaved }: Props) {
  const { t } = useTranslation(NS.MCP);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [createMode, setCreateMode] = useState<"manual" | "json">("manual");
  const [jsonInput, setJsonInput] = useState("");
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [oauthExpanded, setOauthExpanded] = useState(false);
  const server = target && target !== "create" ? target : null;
  const readOnly = server ? !canWriteMcp(server) : false;

  useEffect(() => {
    if (!target) return;
    if (target === "create") {
      setForm(EMPTY_FORM);
      setCreateMode("manual");
      setJsonInput("");
      setOauthExpanded(false);
      return;
    }
    let active = true;
    setLoadingDetail(true);
    void unwrap(mcpApi.get(getMcpLookupKey(target)))
      .then(({ config }) => {
        if (!active) return;
        if ("type" in config && config.type === "local") {
          setForm({
            ...EMPTY_FORM,
            name: target.name,
            type: "local",
            command: stringifyMcpCommand(config.command),
            environment: toEntries(config.environment),
            timeout: config.timeout == null ? "" : String(config.timeout),
          });
          setOauthExpanded(false);
          return;
        }
        if ("type" in config && config.type === "remote") {
          setForm({
            ...EMPTY_FORM,
            name: target.name,
            type: "remote",
            url: config.url,
            headers: toEntries(config.headers),
            timeout: config.timeout == null ? "" : String(config.timeout),
            oauthClientId: config.oauth && typeof config.oauth === "object" ? (config.oauth.clientId ?? "") : "",
            oauthClientSecret:
              config.oauth && typeof config.oauth === "object" ? (config.oauth.clientSecret ?? "") : "",
            oauthScope: config.oauth && typeof config.oauth === "object" ? (config.oauth.scope ?? "") : "",
            oauthRedirectUri: config.oauth && typeof config.oauth === "object" ? (config.oauth.redirectUri ?? "") : "",
          });
          setOauthExpanded(Boolean(config.oauth));
          return;
        }
        setForm({ ...EMPTY_FORM, name: target.name });
      })
      .catch((error: Error) => {
        console.error(t("toast.loadDetailFailed"), error);
        toast.error(t("toast.loadDetailFailed"));
      })
      .finally(() => active && setLoadingDetail(false));
    return () => {
      active = false;
    };
  }, [t, target]);

  const save = useRequest(
    async () => {
      if (!server && createMode === "json") {
        let entries: ReturnType<typeof parseMcpJson>;
        try {
          entries = parseMcpJson(jsonInput);
        } catch (error) {
          if (error instanceof McpImportError) throw new Error(t(error.key));
          throw error;
        }
        const createdNames: string[] = [];
        try {
          for (const entry of entries) {
            await unwrap(mcpApi.create(entry.name, entry.config));
            createdNames.push(entry.name);
          }
        } catch (error) {
          await Promise.allSettled(createdNames.map((name) => unwrap(mcpApi.del(name))));
          throw error;
        }
        return { importedCount: entries.length };
      }

      const validationKey = validateMcpEditor(form);
      if (validationKey) throw new Error(t(validationKey));
      const payload = buildMcpPayload(form);
      await (server ? unwrap(mcpApi.update(server.name, payload)) : unwrap(mcpApi.create(form.name, payload)));
      return { importedCount: null };
    },
    {
      manual: true,
      onSuccess: ({ importedCount }) => {
        toast.success(
          importedCount === null
            ? server
              ? t("toast.serverUpdated")
              : t("toast.serverCreated")
            : t("toast.imported", { count: importedCount }),
        );
        onSaved();
        onClose();
      },
      onError: (error) => {
        console.error(t("toast.saveFailed"), error);
        toast.error(error.message || t("toast.saveFailed"));
      },
    },
  );

  const testUrl = useRequest(
    () => unwrap(mcpApi.testUrl(form.url, entriesToRecord(form.headers), toTimeout(form.timeout))),
    {
      manual: true,
      onSuccess: (result) => {
        if (result.reachable && result.protocol) toast.success(t("toast.testSuccessSimple"));
        else if (result.reachable) toast.warning(t("toast.testReachable", { message: result.message ?? "" }));
        else toast.error(t("toast.testFailed", { message: result.message ?? t("toast.saveFailed") }));
      },
      onError: (error) => toast.error(t("toast.testFailedWith", { message: error.message })),
    },
  );

  return (
    <FormDialog
      open={target !== null}
      onOpenChange={(open) => !open && onClose()}
      title={server ? (readOnly ? t("dialog.detailTitle") : t("dialog.editTitle")) : t("dialog.createTitle")}
      onSubmit={save.run}
      loading={save.loading || loadingDetail}
      hideSubmit={readOnly}
      submitLabel={!server && createMode === "json" ? t("dialog.importAction") : undefined}
      width="sm:max-w-2xl"
    >
      {!server ? (
        <Tabs value={createMode} onValueChange={(value) => setCreateMode(value as "manual" | "json")}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="manual">{t("dialog.manualTab")}</TabsTrigger>
            <TabsTrigger value="json">{t("dialog.jsonTab")}</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}
      {!server && createMode === "json" ? (
        <div className="space-y-3">
          <Field label={t("form.jsonConfig")} hint={t("form.jsonConfigHint")}>
            <Textarea
              value={jsonInput}
              onChange={(event) => setJsonInput(event.target.value)}
              placeholder={
                '{\n  "mcpServers": {\n    "example": {\n      "url": "https://example.com/mcp"\n    }\n  }\n}'
              }
              className="min-h-72 resize-y font-mono text-xs"
              spellCheck={false}
            />
          </Field>
        </div>
      ) : (
        <div className="space-y-4" aria-busy={loadingDetail}>
          <Field label={t("form.name")}>
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              disabled={readOnly || Boolean(server)}
              placeholder="my-mcp-server"
              className="font-mono text-sm"
            />
            {server && <p className="mt-1 text-xs text-text-muted">{t("dialog.nameImmutable")}</p>}
          </Field>

          <Field
            label={t("form.type")}
            hint={form.type === "local" ? t("form.typeLocalDesc") : t("form.typeRemoteDesc")}
          >
            <Select
              value={form.type}
              onValueChange={(value) => setForm({ ...form, type: value as FormState["type"] })}
              disabled={readOnly || Boolean(server)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">{t("form.typeLocalOption")}</SelectItem>
                <SelectItem value="remote">{t("form.typeRemoteOption")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {form.type === "local" ? (
            <>
              <Field label={t("form.command")} hint={t("form.commandHint")}>
                <Input
                  value={form.command}
                  onChange={(event) => setForm({ ...form, command: event.target.value })}
                  disabled={readOnly}
                  placeholder="npx @modelcontextprotocol/server-filesystem"
                  className="font-mono text-sm"
                />
              </Field>
              <KeyValueEditor
                label={t("form.environment")}
                entries={form.environment}
                disabled={readOnly}
                onChange={(environment) => setForm({ ...form, environment })}
              />
            </>
          ) : (
            <>
              <Field label={t("form.url")}>
                <div className="flex gap-2">
                  <Input
                    value={form.url}
                    onChange={(event) => setForm({ ...form, url: event.target.value })}
                    disabled={readOnly}
                    placeholder="https://example.com/mcp"
                    className="flex-1 font-mono text-sm"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={readOnly || !form.url.trim() || testUrl.loading}
                    onClick={testUrl.run}
                  >
                    {testUrl.loading ? t("btn.testing") : t("btn.test")}
                  </Button>
                </div>
              </Field>
              <KeyValueEditor
                label={t("form.headers")}
                entries={form.headers}
                disabled={readOnly}
                namePlaceholder={t("headerNamePlaceholder")}
                valuePlaceholder={t("headerValuePlaceholder")}
                onChange={(headers) => setForm({ ...form, headers })}
              />
              <OAuthEditor
                form={form}
                disabled={readOnly}
                open={oauthExpanded}
                onOpenChange={setOauthExpanded}
                onChange={setForm}
              />
            </>
          )}

          <Field label={t("form.timeout")} hint={t("form.timeoutHint")}>
            <Input
              type="number"
              min={1}
              value={form.timeout}
              onChange={(event) => setForm({ ...form, timeout: event.target.value })}
              disabled={readOnly}
              placeholder="5000"
              className="font-mono text-sm"
            />
          </Field>
        </div>
      )}
    </FormDialog>
  );
}

type Props = { target: McpEditorTarget; onClose: () => void; onSaved: () => void };

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-sm font-medium text-text-primary">{label}</label>
      {hint && <p className="mb-1.5 text-xs text-text-muted">{hint}</p>}
      <div className={hint ? "" : "mt-1"}>{children}</div>
    </div>
  );
}

function KeyValueEditor({
  label,
  entries,
  disabled,
  onChange,
  namePlaceholder = "KEY",
  valuePlaceholder = "VALUE",
}: {
  label: string;
  entries: KeyValueEntry[];
  disabled: boolean;
  onChange: (entries: KeyValueEntry[]) => void;
  namePlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const { t } = useTranslation(NS.MCP);
  const update = (index: number, patch: Partial<KeyValueEntry>) =>
    onChange(entries.map((entry, entryIndex) => (entryIndex === index ? { ...entry, ...patch } : entry)));
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-sm font-medium text-text-primary">{label}</label>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => onChange([...entries, { key: "", value: "" }])}
        >
          {t("btn.add")}
        </Button>
      </div>
      <div className="space-y-2">
        {entries.map((entry, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 该受控列表仅追加和按索引删除，不发生重排。
          <div className="flex items-center gap-2" key={index}>
            <Input
              value={entry.key}
              placeholder={namePlaceholder}
              disabled={disabled}
              onChange={(event) => update(index, { key: event.target.value })}
            />
            <Input
              value={entry.value}
              placeholder={valuePlaceholder}
              disabled={disabled}
              onChange={(event) => update(index, { value: event.target.value })}
            />
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => onChange(entries.filter((_, entryIndex) => entryIndex !== index))}
            >
              {t("btn.delete")}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function OAuthEditor({
  form,
  disabled,
  open,
  onOpenChange,
  onChange,
}: {
  form: FormState;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (form: FormState) => void;
}) {
  const { t } = useTranslation(NS.MCP);
  return (
    <Collapsible open={open} onOpenChange={disabled ? undefined : onOpenChange}>
      <div className="rounded-lg border border-border-light">
        <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-text-primary">
          {t("form.oauthConfig")}
          <span className="text-xs text-text-muted">{open ? t("form.oauthCollapse") : t("form.oauthExpand")}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid grid-cols-2 gap-3 border-t border-border-light px-4 pb-4 pt-4">
            {(["oauthClientId", "oauthClientSecret", "oauthScope", "oauthRedirectUri"] as const).map((key) => (
              <Field
                key={key}
                label={t(
                  `form.${key === "oauthClientId" ? "clientId" : key === "oauthClientSecret" ? "clientSecret" : key === "oauthScope" ? "scope" : "redirectUri"}`,
                )}
              >
                <Input
                  type={key === "oauthClientSecret" ? "password" : "text"}
                  value={form[key]}
                  disabled={disabled}
                  placeholder={t("form.optional")}
                  onChange={(event) => onChange({ ...form, [key]: event.target.value })}
                />
              </Field>
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function toEntries(record?: Record<string, unknown>): KeyValueEntry[] {
  return record
    ? Object.entries(record).map(([key, value]) => ({ key, value: String(value) }))
    : [{ key: "", value: "" }];
}

function entriesToRecord(entries: KeyValueEntry[]): Record<string, string> | undefined {
  const valid = entries.filter((entry) => entry.key.trim());
  return valid.length ? Object.fromEntries(valid.map((entry) => [entry.key, entry.value])) : undefined;
}

function toTimeout(value: string): number | undefined {
  return value ? Number.parseInt(value, 10) : undefined;
}
