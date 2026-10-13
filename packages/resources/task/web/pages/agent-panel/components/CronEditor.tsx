import { Button } from "@fenix/ui-components/ui/button";
import { Input } from "@fenix/ui-components/ui/input";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { validateCronExpression } from "../pages/agent-tasks-utils";
import { CHOICE_CHIP_CLASS } from "./chip-classes";

/** cron 预设：内部 ID → cron 表达式 */
export const PRESETS: Record<string, string> = {
  every5min: "*/5 * * * *",
  everyHour: "0 * * * *",
  daily9am: "0 9 * * *",
  weekday9am: "0 9 * * 1-5",
  monthly1st: "0 0 1 * *",
};

/** 文案取值口径：`t(key)` / `t(key, { var })`；与 `agent-tasks-utils` 的 `formatTaskRelativeTime` 同形。 */
type CronText = (key: string, options?: Record<string, unknown>) => string;

/** 星期字段索引（0 = 周日）→ 字形键；越界索引没有键，`join` 时按空串处理（既有行为）。 */
const WEEKDAY_KEYS = [
  "cron.describe.weekday.sun",
  "cron.describe.weekday.mon",
  "cron.describe.weekday.tue",
  "cron.describe.weekday.wed",
  "cron.describe.weekday.thu",
  "cron.describe.weekday.fri",
  "cron.describe.weekday.sat",
];

/**
 * 12 小时制展示三元组。`describeCron` 的四个分支（每天 / 每周 / 每月 / 指定月）此前各抄一份同样的 3 行换算
 * （2026-09-22 去重）。时段词经 `t` 取（2026-09-23 第 19 轮）：此前中文写死在这里，
 * 非中文界面会读成「每天下午 3:30」。
 */
function twelveHourParts(h: number, min: string, t: CronText): { period: string; h12: number; minStr: string } {
  return {
    period:
      h < 12 ? t("cron.describe.period.am") : h === 12 ? t("cron.describe.period.noon") : t("cron.describe.period.pm"),
    h12: h === 0 ? 12 : h > 12 ? h - 12 : h,
    minStr: min === "*" ? "" : `:${min.padStart(2, "0")}`,
  };
}

/** 星期索引 → 字形；越界索引返回 `undefined`（`Array.prototype.join` 会把它渲染成空串）。 */
function weekdayName(index: number, t: CronText): string | undefined {
  const key = WEEKDAY_KEYS[index];
  return key ? t(key) : undefined;
}

/**
 * 根据 cron 表达式返回人类可读的描述，需要 t 函数做国际化。
 *
 * 四条动态模板与时段 / 星期字形都来自 `cron.describe.*` 字典（2026-09-23 第 19 轮收口，此前是
 * 拼在代码里的中文字符串）。各分支的既有差异原样保留——**指定月分支的时段与时刻之间没有空格**，
 * 归一那处会改用户可见文案；该差异现在由 `monthlyOnDate` 这一条模板自己承担。
 */
export function describeCron(cron: string, t: CronText): string | null {
  const match = Object.entries(PRESETS).find(([, v]) => v === cron.trim());
  if (match) return t(`cron.presets.${match[0]}`);

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [min, hour, day, month, weekday] = parts;

  if (min.startsWith("*/")) {
    return t("cron.describe.everyMinutes", { minutes: min.slice(2) });
  }

  if (hour !== "*" && day === "*" && month === "*" && weekday === "*") {
    const h = Number.parseInt(hour, 10);
    if (!Number.isNaN(h)) {
      const { period, h12, minStr } = twelveHourParts(h, min, t);
      return t("cron.describe.daily", { period, time: `${h12}${minStr}` });
    }
  }

  if (hour !== "*" && day === "*" && month === "*" && weekday !== "*") {
    const h = Number.parseInt(hour, 10);
    if (!Number.isNaN(h) && /^[\d,-]+$/.test(weekday)) {
      const dayNums = weekday.includes("-") ? [weekday] : weekday.split(",");
      const dayNames = dayNums.flatMap((d) => {
        if (d.includes("-")) {
          const [s, e] = d.split("-").map(Number);
          return Array.from({ length: e - s + 1 }, (_, i) => weekdayName(s + i, t));
        }
        return [weekdayName(Number(d), t)];
      });
      const { period, h12, minStr } = twelveHourParts(h, min, t);
      return t("cron.describe.weekly", {
        days: dayNames.join(t("cron.describe.daySeparator")),
        period,
        time: `${h12}${minStr}`,
      });
    }
  }

  if (hour !== "*" && day !== "*" && month === "*" && weekday === "*") {
    const h = Number.parseInt(hour, 10);
    const d = Number.parseInt(day, 10);
    if (!Number.isNaN(h) && !Number.isNaN(d)) {
      const { period, h12, minStr } = twelveHourParts(h, min, t);
      return t("cron.describe.monthly", { day: d, period, time: `${h12}${minStr}` });
    }
  }

  if (hour !== "*" && day !== "*" && month !== "*" && weekday === "*") {
    const h = Number.parseInt(hour, 10);
    const d = Number.parseInt(day, 10);
    const m = Number.parseInt(month, 10);
    if (!Number.isNaN(h) && !Number.isNaN(d) && !Number.isNaN(m)) {
      const { period, h12, minStr } = twelveHourParts(h, min, t);
      return t("cron.describe.monthlyOnDate", { month: m, day: d, period, time: `${h12}${minStr}` });
    }
  }

  return null;
}

export interface CronEditorProps {
  value: string;
  timezone?: string;
  /** 手动输入框的 `id`：供调用方用 `LabeledField htmlFor` 把字段名显式关联到这个输入框；不给则不渲染 `id`。 */
  inputId?: string;
  onChange: (cron: string) => void;
  /** 外部错误（来自表单校验的 `errors.cron.message`）：**同样是 i18n 键**，渲染时才译。 */
  error?: string;
}

export function CronEditor({ value, timezone = "", inputId, onChange, error }: CronEditorProps) {
  const { t } = useTranslation(NS.TASKS_V2);
  const [editingCustom, setEditingCustom] = useState(false);
  // 防抖后的错误**键**：`validateCronExpression` 只产出键（§9.3 的纯模块不碰字典），
  // 译文在渲染时取——因此下面的 effect 依赖里不需要 `t`，语言切换不会重跑校验。
  const [debouncedErrorKey, setDebouncedErrorKey] = useState<string>();

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedErrorKey(validateCronExpression(value, timezone)), 400);
    return () => clearTimeout(timer);
  }, [value, timezone]);

  // IME 安全：composing 期间使用独立 value 避免受控值覆盖 IME 中间文字
  const [isComposing, setIsComposing] = useState(false);
  const [composingValue, setComposingValue] = useState("");

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
    // 清空 cron 值以使预设标签取消高亮，同时让用户从空白开始输入
    if (isPreset) {
      onChange("");
    }
  };

  const displayErrorKey = error ?? debouncedErrorKey;

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
                className={CHOICE_CHIP_CLASS}
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
            className={CHOICE_CHIP_CLASS}
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
                <div className="text-3xs text-text-muted">{isPreset ? t("cron.preset") : t("cron.parsedResult")}</div>
              </>
            ) : (
              <div className="text-sm text-text-muted">{t("cron.customCron")}</div>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-1">
            <span className="text-3xs text-text-muted shrink-0 font-mono">cron:</span>
            <Input
              id={inputId}
              value={isComposing ? composingValue : value}
              onCompositionStart={() => {
                setIsComposing(true);
                setComposingValue(value);
              }}
              onCompositionUpdate={(e) => {
                setComposingValue((e.target as HTMLInputElement).value);
              }}
              onCompositionEnd={(e) => {
                setIsComposing(false);
                setComposingValue("");
                onChange((e.target as HTMLInputElement).value);
                setEditingCustom(true);
              }}
              onChange={(e) => {
                if (isComposing) {
                  setComposingValue(e.target.value);
                } else {
                  onChange(e.target.value);
                  setEditingCustom(true);
                }
              }}
              placeholder="0 * * * *"
              className={`h-7 flex-1 font-mono text-xs ${displayErrorKey ? "border-destructive" : ""}`}
            />
          </div>
        </div>
        {displayErrorKey && <p className="text-xs text-destructive">{t(displayErrorKey)}</p>}
      </div>
    </div>
  );
}
