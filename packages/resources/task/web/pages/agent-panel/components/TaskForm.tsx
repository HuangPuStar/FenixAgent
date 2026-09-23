import { LabeledField } from "@fenix/ui-components/config/LabeledField";
import { Input } from "@fenix/ui-components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@fenix/ui-components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@fenix/ui-components/ui/tabs";
import { Textarea } from "@fenix/ui-components/ui/textarea";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import type { AgentInfo } from "@fenix/web-runtime/types/config";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
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

/**
 * 表单错误行。8 个字段此前各写一份同样的
 * `{errors.x && <p className="mt-0.5 text-xs text-destructive">{errors.x.message}</p>}`，
 * 收敛成组件而不只抽类串常量，是因为连取值分支也只该写一次。
 *
 * 必须渲染在 `LabeledField` **之外**：`<p>` 一旦落进 `<label>`，错误文案会被算进控件的可访问名。
 * 判空按 `message`（原先按 `errors.x` 对象）——zodResolver 校验失败时恒带 message，无可观察差异。
 */
function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-0.5 text-xs text-destructive">{message}</p>;
}

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
        <LabeledField label={t("form.nameLabel")}>
          <Input
            {...register("name")}
            placeholder={t("form.namePlaceholder")}
            className={`w-full ${errors.name ? "border-destructive" : ""}`}
          />
        </LabeledField>
        <FieldError message={errors.name?.message} />
      </div>

      <div className="rounded-lg border border-border/40 bg-surface-0 p-3 space-y-3">
        <div>
          {/* 字段名走**显式关联**：children 是「预设 chip 行 + 输入框」的复合控件，chip 是可标记的
              `<button>`，包进 `<label>` 会把预设文案并进输入框的可访问名。`htmlFor` 指向 CronEditor
              内部的 cron 输入框（该 id 经 `inputId` 传下去）。 */}
          <LabeledField label={t("form.timeLabel")} htmlFor="task-cron">
            <CronEditor
              inputId="task-cron"
              value={cronValue || ""}
              timezone={timezoneValue || ""}
              onChange={(v) => setValue("cron", v)}
              error={errors.cron?.message}
            />
          </LabeledField>
        </div>

        <div>
          {/* 字段名走**显式关联**：字段名标注的是下方那个输入框（`htmlFor` + 控件 `id`），children 里的
              选项面板是绝对定位的、内含可标记的 `<button>`，包进 `<label>` 会把选项文案并进输入框的
              可访问名。提示走 `hint`，仍渲染在 `</label>` 之外。 */}
          <LabeledField
            label={t("form.timezoneLabel")}
            htmlFor="task-timezone"
            hint="可搜索 IANA 时区，留空使用默认时区"
          >
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
          </LabeledField>
          <FieldError message={errors.timezone?.message} />
        </div>

        <div>
          <LabeledField label={t("form.timeoutLabel")}>
            <Input
              type="number"
              {...register("timeoutSeconds", { valueAsNumber: true })}
              className={`w-full ${errors.timeoutSeconds ? "border-destructive" : ""}`}
            />
          </LabeledField>
          <FieldError message={errors.timeoutSeconds?.message} />
        </div>
      </div>

      <div>
        <LabeledField label={t("form.descLabel")}>
          <Input
            {...register("description")}
            placeholder={t("form.descPlaceholder")}
            className={`w-full ${errors.description ? "border-destructive" : ""}`}
          />
        </LabeledField>
        <FieldError message={errors.description?.message} />
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
            {/* 字段名走**显式关联**：children 是 URL 输入框 + 方法选择器（可标记的 `<button>`），
                字段名只该标注输入框；包进 `<label>` 会把方法文案并进它的可访问名。 */}
            <LabeledField label={t("form.urlLabel")} htmlFor="task-url">
              <div className="flex gap-2">
                <Input
                  id="task-url"
                  {...register("url")}
                  placeholder="https://example.com/webhook"
                  className={`flex-1 ${errors.url ? "border-destructive" : ""}`}
                />
                <Select
                  value={methodValue}
                  onValueChange={(v) => setValue("method", v as "GET" | "POST" | "PUT" | "DELETE" | "PATCH")}
                >
                  <SelectTrigger className="w-27.5">
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
            </LabeledField>
            <FieldError message={errors.url?.message} />
          </div>
          <div>
            <LabeledField label={t("form.headersLabel")}>
              <Textarea
                {...register("headers")}
                placeholder={t("form.headersPlaceholder")}
                className={`font-mono text-xs h-16 w-full ${errors.headers ? "border-destructive" : ""}`}
              />
            </LabeledField>
            <FieldError message={errors.headers?.message} />
          </div>
          <div>
            <LabeledField label={t("form.bodyLabel")}>
              <Textarea
                {...register("body")}
                placeholder={t("form.bodyPlaceholder")}
                className="font-mono text-xs h-20 w-full"
              />
            </LabeledField>
          </div>
        </div>
      )}

      {/* Agent 条件字段 */}
      {effectiveType === "agent" && (
        <div className="space-y-4">
          <div>
            <LabeledField label={t("form.agentLabel")}>
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
            </LabeledField>
            <FieldError message={errors.agentId?.message} />
          </div>
          <div>
            <LabeledField label={t("form.promptLabel")}>
              <Textarea
                {...register("prompt")}
                placeholder={t("form.promptPlaceholder")}
                className={`h-32 w-full ${errors.prompt ? "border-destructive" : ""}`}
              />
            </LabeledField>
            <FieldError message={errors.prompt?.message} />
          </div>
        </div>
      )}
    </div>
  );
}
