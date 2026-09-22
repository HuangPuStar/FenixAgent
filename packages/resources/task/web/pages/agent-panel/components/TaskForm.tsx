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
 * 字段名样式，与实际迁移后仍需手写的三个字段（执行时间 / 时区 / URL）配套。
 *
 * 颜色取 `text-text-primary`：这是 `LabeledField` 里字段名的色，本表单 7 个字段已改用该组件，
 * 三者若继续用 `text-text-muted` 会在同一个表单里出现两种深浅的字段名。字号与字重本就一致。
 * 间距仍为 `mb-1`（4px），与 `LabeledField` 的 `gap-1.5`（6px）差 2px——这 4 个字段的形态不是
 * 「label + 单个控件」（见下方各自的注释），故未迁移，间距差异一并保留。
 */
const LABEL_CLASS = "block text-sm font-medium text-text-primary mb-1";

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
          {/* 本字段的字段名仍手写：children 是「预设 chip 行 + 输入框」的复合控件，chip 是可标记的
              `<button>`，`LabeledField` 的隐式关联会把预设文案并进输入框的可访问名。 */}
          <label className={LABEL_CLASS}>{t("form.timeLabel")}</label>
          <CronEditor
            value={cronValue || ""}
            timezone={timezoneValue || ""}
            onChange={(v) => setValue("cron", v)}
            error={errors.cron?.message}
          />
        </div>

        <div>
          {/* 本字段的字段名仍手写：它有既有的显式关联（`htmlFor` + 控件 `id`），而 `LabeledField`
              只走隐式关联、不接 `htmlFor`；children 里的选项面板是绝对定位的，内含可标记的
              `<button>`，聚焦即展开，包进 `<label>` 会把选项文案并进输入框的可访问名。 */}
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
            {/* 本字段的字段名仍手写：children 是 URL 输入框 + 方法选择器（可标记的 `<button>`），
                不是「label + 单个控件」；包进 `<label>` 会把方法文案并进 URL 输入框的可访问名。 */}
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
