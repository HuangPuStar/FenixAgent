import { useCallback, useEffect } from "react";
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

const LABEL_CLASS = "w-[96px] shrink-0 text-right text-sm text-text-muted pr-3";

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
  const methodValue = useWatch({ control, name: "method" }) || "POST";
  const agentIdValue = useWatch({ control, name: "agentId" });
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
    <div className="space-y-3">
      {/* 公共字段 */}
      <div className="flex items-center">
        <label className={LABEL_CLASS}>{t("form.nameLabel")}</label>
        <Input
          {...register("name")}
          placeholder={t("form.namePlaceholder")}
          className={`flex-1 ${errors.name ? "border-destructive" : ""}`}
        />
      </div>

      <div className="flex items-start">
        <label className={`${LABEL_CLASS} pt-1.5`}>{t("form.timeLabel")}</label>
        <div className="flex-1">
          <CronEditor value={cronValue || ""} onChange={(v) => setValue("cron", v)} error={errors.cron?.message} />
        </div>
      </div>

      <div className="flex items-center">
        <label className={LABEL_CLASS}>{t("form.timezoneLabel")}</label>
        <Input {...register("timezone")} placeholder="Asia/Shanghai" className="flex-1" />
      </div>

      <div className="flex items-center">
        <label className={LABEL_CLASS}>{t("form.timeoutLabel")}</label>
        <Input
          type="number"
          {...register("timeoutSeconds", { valueAsNumber: true })}
          className={`flex-1 ${errors.timeoutSeconds ? "border-destructive" : ""}`}
        />
      </div>

      <div className="flex items-center">
        <label className={LABEL_CLASS}>{t("form.descLabel")}</label>
        <Input {...register("description")} placeholder={t("form.descPlaceholder")} className="flex-1" />
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
        <div className="space-y-3">
          <div className="flex items-center">
            <label className={LABEL_CLASS}>{t("form.urlLabel")}</label>
            <div className="flex gap-2 flex-1">
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
          </div>
          <div className="flex items-start">
            <label className={`${LABEL_CLASS} pt-2`}>{t("form.headersLabel")}</label>
            <div className="flex-1 space-y-1">
              <Textarea
                {...register("headers")}
                placeholder={t("form.headersPlaceholder")}
                className={`font-mono text-xs h-14 ${errors.headers ? "border-destructive" : ""}`}
              />
              {errors.headers && <p className="text-xs text-destructive">{errors.headers.message}</p>}
            </div>
          </div>
          <div className="flex items-start">
            <label className={`${LABEL_CLASS} pt-2`}>{t("form.bodyLabel")}</label>
            <Textarea
              {...register("body")}
              placeholder={t("form.bodyPlaceholder")}
              className="flex-1 font-mono text-xs h-16"
            />
          </div>
        </div>
      )}

      {/* Agent 条件字段 */}
      {effectiveType === "agent" && (
        <div className="space-y-3">
          <div className="flex items-center">
            <label className={LABEL_CLASS}>{t("form.agentLabel")}</label>
            <Select value={agentIdValue as string} onValueChange={(v) => setValue("agentId", v)}>
              <SelectTrigger className={`flex-1 ${errors.agentId ? "border-destructive" : ""}`}>
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
          </div>
          <div className="flex items-start">
            <label className={`${LABEL_CLASS} pt-2`}>{t("form.promptLabel")}</label>
            <div className="flex-1 space-y-1">
              <Textarea
                {...register("prompt")}
                placeholder={t("form.promptPlaceholder")}
                className={`h-28 ${errors.prompt ? "border-destructive" : ""}`}
              />
              {errors.prompt && <p className="text-xs text-destructive">{errors.prompt.message}</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
