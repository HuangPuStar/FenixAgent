import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { NS } from "@/src/i18n";
import type { AgentInfo } from "@/src/types/config";
import { CronEditor } from "./CronEditor";

export interface TaskFormValues {
  type: "http" | "agent";
  name: string;
  cron: string;
  timezone: string;
  timeoutSeconds: number;
  description: string;
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers: string;
  body: string;
  agentId: string;
  prompt: string;
}

interface TaskFormProps {
  agents: AgentInfo[];
  isEditing: boolean;
  initialType?: "http" | "agent";
}

const LABEL_CLASS = "block text-sm font-medium text-text-muted mb-1";
const COMMON_TIMEZONES = [
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Kolkata",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/Los_Angeles",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
];

const TIMEZONES = (() => {
  const intlWithTimezones = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
  const values = intlWithTimezones.supportedValuesOf?.("timeZone") ?? COMMON_TIMEZONES;
  return values.includes("UTC") ? values : ["UTC", ...values];
})();

function getLocalTimezoneOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

function getTimezoneOffsetMinutes(timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" }).formatToParts(
    new Date(),
  );
  const offset = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = offset.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!match) return 0;
  return (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

export function TaskForm({ agents, isEditing, initialType = "http" }: TaskFormProps) {
  const { t } = useTranslation(NS.TASKS_V2);
  const {
    register,
    control,
    setValue,
    formState: { errors },
  } = useFormContext<TaskFormValues>();
  const type = useWatch({ control, name: "type" });
  const cronValue = useWatch({ control, name: "cron" });
  const timezoneValue = useWatch({ control, name: "timezone" });
  const methodValue = useWatch({ control, name: "method" }) || "POST";
  const agentIdValue = useWatch({ control, name: "agentId" });
  const [timezonePickerOpen, setTimezonePickerOpen] = useState(false);
  const timezoneInputRef = useRef<HTMLInputElement>(null);
  const timezoneOptions = useMemo(() => {
    const localOffset = getLocalTimezoneOffsetMinutes();
    return TIMEZONES.map((timezone) => ({
      timezone,
      offset: getTimezoneOffsetMinutes(timezone),
      commonIndex: COMMON_TIMEZONES.indexOf(timezone),
    })).sort(
      (a, b) =>
        Math.abs(a.offset - localOffset) - Math.abs(b.offset - localOffset) ||
        (a.commonIndex < 0 ? Number.MAX_SAFE_INTEGER : a.commonIndex) -
          (b.commonIndex < 0 ? Number.MAX_SAFE_INTEGER : b.commonIndex) ||
        a.timezone.localeCompare(b.timezone),
    );
  }, []);
  const effectiveType = (type as "http" | "agent") || initialType;
  // 新建时初始化 type
  useEffect(() => {
    if (!isEditing && !type) {
      setValue("type", initialType);
    }
  }, [isEditing, type, initialType, setValue]);

  const handleTypeChange = useCallback(
    (newType: "http" | "agent") => {
      setValue("type", newType);
    },
    [setValue],
  );

  return (
    <div className="space-y-4">
      {/* 公共字段 */}
      <div>
        <label className={LABEL_CLASS}>{t("form.nameLabel")}</label>
        <Input
          {...register("name")}
          placeholder={t("form.namePlaceholder")}
          className={`w-full ${errors.name ? "border-destructive" : ""}`}
        />
        {errors.name && <p className="mt-0.5 text-xs text-destructive">{errors.name.message}</p>}
      </div>

      <div className="rounded-lg border border-border/40 bg-surface-0 p-3 space-y-3">
        <div>
          <label className={LABEL_CLASS}>{t("form.timeLabel")}</label>
          <CronEditor
            value={cronValue || ""}
            timezone={timezoneValue || ""}
            onChange={(v) => setValue("cron", v)}
            error={errors.cron?.message}
          />
        </div>

        <div>
          <label className={LABEL_CLASS} htmlFor="task-timezone">
            {t("form.timezoneLabel")}
          </label>
          <div className="relative">
            <Input
              id="task-timezone"
              ref={timezoneInputRef}
              value={timezoneValue || ""}
              onFocus={() => setTimezonePickerOpen(true)}
              onChange={(event) => {
                setValue("timezone", event.target.value, { shouldValidate: true });
                setTimezonePickerOpen(true);
              }}
              onBlur={() => window.setTimeout(() => setTimezonePickerOpen(false), 150)}
              placeholder="使用默认时区"
              className={`w-full ${errors.timezone ? "border-destructive" : ""}`}
            />
            {timezonePickerOpen && (
              <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
                <button
                  type="button"
                  className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setValue("timezone", "", { shouldValidate: true });
                    setTimezonePickerOpen(false);
                  }}
                >
                  使用默认时区
                </button>
                {timezoneOptions
                  .filter(({ timezone }) => timezone.toLowerCase().includes((timezoneValue || "").toLowerCase()))
                  .map(({ timezone }) => (
                    <button
                      type="button"
                      key={timezone}
                      className="block w-full truncate rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setValue("timezone", timezone, { shouldValidate: true });
                        setTimezonePickerOpen(false);
                      }}
                    >
                      {timezone}
                    </button>
                  ))}
              </div>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">可搜索 IANA 时区，留空使用默认时区</p>
          {errors.timezone && <p className="mt-0.5 text-xs text-destructive">{errors.timezone.message}</p>}
        </div>

        <div>
          <label className={LABEL_CLASS}>{t("form.timeoutLabel")}</label>
          <Input
            type="number"
            {...register("timeoutSeconds", { valueAsNumber: true })}
            className={`w-full ${errors.timeoutSeconds ? "border-destructive" : ""}`}
          />
          {errors.timeoutSeconds && <p className="mt-0.5 text-xs text-destructive">{errors.timeoutSeconds.message}</p>}
        </div>
      </div>

      <div>
        <label className={LABEL_CLASS}>{t("form.descLabel")}</label>
        <Input
          {...register("description")}
          placeholder={t("form.descPlaceholder")}
          className={`w-full ${errors.description ? "border-destructive" : ""}`}
        />
        {errors.description && <p className="mt-0.5 text-xs text-destructive">{errors.description.message}</p>}
      </div>

      {/* Type Tabs */}
      <Tabs value={effectiveType} onValueChange={(v) => handleTypeChange(v as "http" | "agent")}>
        <TabsList variant="line" className="w-full justify-start">
          <TabsTrigger
            value="http"
            disabled={isEditing}
            className="text-sm data-[state=active]:text-text-bright data-[state=inactive]:text-text-muted"
          >
            {t("form.typeHttp")}
          </TabsTrigger>
          <TabsTrigger
            value="agent"
            disabled={isEditing}
            className="text-sm data-[state=active]:text-text-bright data-[state=inactive]:text-text-muted"
          >
            {t("form.typeAgent")}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* HTTP 条件字段 */}
      {effectiveType === "http" && (
        <div className="space-y-4">
          <div>
            <label className={LABEL_CLASS}>{t("form.urlLabel")}</label>
            <div className="flex gap-2">
              <Input
                {...register("url")}
                placeholder="https://example.com/webhook"
                className={`flex-1 ${errors.url ? "border-destructive" : ""}`}
              />
              <Select
                value={methodValue}
                onValueChange={(v) => setValue("method", v as "GET" | "POST" | "PUT" | "DELETE" | "PATCH")}
              >
                <SelectTrigger className="w-[110px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GET">GET</SelectItem>
                  <SelectItem value="POST">POST</SelectItem>
                  <SelectItem value="PUT">PUT</SelectItem>
                  <SelectItem value="DELETE">DELETE</SelectItem>
                  <SelectItem value="PATCH">PATCH</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {errors.url && <p className="mt-0.5 text-xs text-destructive">{errors.url.message}</p>}
          </div>
          <div>
            <label className={LABEL_CLASS}>{t("form.headersLabel")}</label>
            <Textarea
              {...register("headers")}
              placeholder={t("form.headersPlaceholder")}
              className={`font-mono text-xs h-16 w-full ${errors.headers ? "border-destructive" : ""}`}
            />
            {errors.headers && <p className="mt-0.5 text-xs text-destructive">{errors.headers.message}</p>}
          </div>
          <div>
            <label className={LABEL_CLASS}>{t("form.bodyLabel")}</label>
            <Textarea
              {...register("body")}
              placeholder={t("form.bodyPlaceholder")}
              className="font-mono text-xs h-20 w-full"
            />
          </div>
        </div>
      )}

      {/* Agent 条件字段 */}
      {effectiveType === "agent" && (
        <div className="space-y-4">
          <div>
            <label className={LABEL_CLASS}>{t("form.agentLabel")}</label>
            <Select value={agentIdValue as string} onValueChange={(v) => setValue("agentId", v)}>
              <SelectTrigger className={`w-full ${errors.agentId ? "border-destructive" : ""}`}>
                <SelectValue placeholder={t("form.agentPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                    {a.model ? ` (${a.model})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.agentId && <p className="mt-0.5 text-xs text-destructive">{errors.agentId.message}</p>}
          </div>
          <div>
            <label className={LABEL_CLASS}>{t("form.promptLabel")}</label>
            <Textarea
              {...register("prompt")}
              placeholder={t("form.promptPlaceholder")}
              className={`h-32 w-full ${errors.prompt ? "border-destructive" : ""}`}
            />
            {errors.prompt && <p className="mt-0.5 text-xs text-destructive">{errors.prompt.message}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
