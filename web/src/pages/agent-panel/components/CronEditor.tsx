import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NS } from "@/src/i18n";

/** cron 预设：内部 ID → cron 表达式 */
export const PRESETS: Record<string, string> = {
  every5min: "*/5 * * * *",
  everyHour: "0 * * * *",
  daily9am: "0 9 * * *",
  weekday9am: "0 9 * * 1-5",
  monthly1st: "0 0 1 * *",
};

/** 根据 cron 表达式返回人类可读的描述，需要 t 函数做国际化 */
export function describeCron(cron: string, t: (key: string) => string): string | null {
  const match = Object.entries(PRESETS).find(([, v]) => v === cron.trim());
  if (match) return t(`cron.presets.${match[0]}`);

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [min, hour, day, month, weekday] = parts;

  if (min.startsWith("*/")) {
    return `每 ${min.slice(2)} 分钟`;
  }

  if (hour !== "*" && day === "*" && month === "*" && weekday === "*") {
    const h = Number.parseInt(hour, 10);
    if (!Number.isNaN(h)) {
      const period = h < 12 ? "上午" : h === 12 ? "中午" : "下午";
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const minStr = min === "*" ? "" : `:${min.padStart(2, "0")}`;
      return `每天${period} ${h12}${minStr}`;
    }
  }

  if (hour !== "*" && day === "*" && month === "*" && weekday !== "*") {
    const h = Number.parseInt(hour, 10);
    const days = ["日", "一", "二", "三", "四", "五", "六"];
    if (!Number.isNaN(h) && /^[\d,-]+$/.test(weekday)) {
      const dayNums = weekday.includes("-") ? [weekday] : weekday.split(",");
      const dayNames = dayNums.flatMap((d) => {
        if (d.includes("-")) {
          const [s, e] = d.split("-").map(Number);
          return Array.from({ length: e - s + 1 }, (_, i) => days[s + i]);
        }
        return [days[Number(d)]];
      });
      const period = h < 12 ? "上午" : h === 12 ? "中午" : "下午";
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const minStr = min === "*" ? "" : `:${min.padStart(2, "0")}`;
      return `每周${dayNames.join("、")}${period} ${h12}${minStr}`;
    }
  }

  if (hour !== "*" && day !== "*" && month === "*" && weekday === "*") {
    const h = Number.parseInt(hour, 10);
    const d = Number.parseInt(day, 10);
    if (!Number.isNaN(h) && !Number.isNaN(d)) {
      const period = h < 12 ? "上午" : h === 12 ? "中午" : "下午";
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const minStr = min === "*" ? "" : `:${min.padStart(2, "0")}`;
      return `每月 ${d} 号${period} ${h12}${minStr}`;
    }
  }

  if (hour !== "*" && day !== "*" && month !== "*" && weekday === "*") {
    const h = Number.parseInt(hour, 10);
    const d = Number.parseInt(day, 10);
    const m = Number.parseInt(month, 10);
    if (!Number.isNaN(h) && !Number.isNaN(d) && !Number.isNaN(m)) {
      const period = h < 12 ? "上午" : h === 12 ? "中午" : "下午";
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const minStr = min === "*" ? "" : `:${min.padStart(2, "0")}`;
      return `${m}月${d}号${period}${h12}${minStr}`;
    }
  }

  return null;
}

export interface CronEditorProps {
  value: string;
  onChange: (cron: string) => void;
  error?: string;
}

export function CronEditor({ value, onChange, error }: CronEditorProps) {
  const { t } = useTranslation(NS.TASKS_V2);
  const [editingCustom, setEditingCustom] = useState(false);

  const presetKeys = Object.keys(PRESETS);
  const matchedKey = Object.entries(PRESETS).find(([, v]) => v === value.trim())?.[0];
  const isPreset = matchedKey != null;

  const desc = describeCron(value, t);

  const handlePresetClick = (key: string) => {
    setEditingCustom(false);
    onChange(PRESETS[key]);
  };

  const handleCustomClick = () => {
    setEditingCustom(true);
  };

  return (
    <div className="space-y-3">
      {/* 快捷选择 */}
      <div className="space-y-1.5">
        <div className="text-xs text-text-muted">{t("cron.quickSelect")}</div>
        <div className="flex flex-wrap gap-1.5">
          {presetKeys.map((key) => {
            const active = matchedKey === key;
            return (
              <Button
                key={key}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                className="rounded-full h-6 px-3 text-xs font-normal"
                onClick={() => handlePresetClick(key)}
              >
                {t(`cron.presets.${key}`)}
              </Button>
            );
          })}
          <Button
            type="button"
            size="sm"
            variant={editingCustom || !isPreset ? "default" : "outline"}
            className="rounded-full h-6 px-3 text-xs font-normal"
            onClick={handleCustomClick}
          >
            {t("cron.custom")}
          </Button>
        </div>
      </div>

      {/* 手动输入 */}
      <div className="space-y-1">
        <div className="flex items-center gap-3 rounded-md border border-border-light bg-surface-0 px-3 py-2">
          <div className="shrink-0 text-right min-w-0">
            {desc ? (
              <>
                <div className="text-sm font-medium text-text-bright">{desc}</div>
                <div className="text-[11px] text-text-muted">
                  {isPreset ? t("cron.preset") : t("cron.parsedResult")}
                </div>
              </>
            ) : (
              <div className="text-sm text-text-muted">{t("cron.customCron")}</div>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-1">
            <span className="text-[11px] text-text-muted shrink-0 font-mono">cron:</span>
            <Input
              value={value}
              onChange={(e) => {
                onChange(e.target.value);
                setEditingCustom(true);
              }}
              placeholder="0 * * * *"
              className={`h-7 flex-1 font-mono text-xs ${error ? "border-destructive" : ""}`}
            />
          </div>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}
