/**
 * cron 表达式编辑器：预设快选 + 自定义输入 + 防抖校验。
 *
 * 来源：`packages/resources/task/web/pages/agent-panel/components/CronEditor.tsx`。
 *
 * 纯化取舍：
 * - i18n 命名空间由宿主 `NS.TASKS_V2` 换为包内 `UI_COMPONENTS_NS`，组件用到的 `cron.*` 键整体迁入包内字典
 *   （`cron.quickSelect` / `cron.custom` / `cron.preset` / `cron.parsedResult` / `cron.customCron` /
 *   `cron.presets.*`）；
 * - `describeCron` / `validateCron` 里原先硬编码的中文（每 N 分钟、上午 / 中午 / 下午、星期名、三条校验错误）
 *   改为经 t 取包内 `cron.describe.*` / `cron.error.*` 文案，因此 t 的签名放宽为 `CronTranslate`
 *   （key + 可选插值），`useTranslation` 返回的 t 仍可直接传入；中文输出与源实现逐字一致，英文由字典给出
 *   （英文模板把时段词放在时间之后，充当 AM / PM 语义）；
 *   `describeCron` 的契约不变：只对已识别模式返回描述串，其余返回 null；
 * - 校验 effect 的依赖补上 t，语言切换后已显示的校验错误才会跟着刷新（源实现无国际化，故无此依赖）；
 * - 组件结构、样式类名、IME 组合输入处理与 PRESETS 表达式逐字保留；运行期依赖 `cron-parser`（与源实现一致）。
 */
import { parseExpression } from "cron-parser";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { UI_COMPONENTS_NS } from "../lib/i18n";
import { Button } from "./button";
import { Input } from "./input";

/** cron 预设：内部 ID → cron 表达式 */
export const PRESETS: Record<string, string> = {
  every5min: "*/5 * * * *",
  everyHour: "0 * * * *",
  daily9am: "0 9 * * *",
  weekday9am: "0 9 * * 1-5",
  monthly1st: "0 0 1 * *",
};

/**
 * describeCron / validateCron 需要的翻译函数形态：key + 可选插值参数。
 *
 * 刻意只要求这个最小结构：包内纯函数不应绑死在 i18next `TFunction` 的重载签名上，
 * 而 `useTranslation(UI_COMPONENTS_NS)` 返回的 t 可直接传入。
 */
export type CronTranslate = (key: string, options?: Record<string, unknown>) => string;

/** 星期字段数字 → 包内文案键（顺序即 cron 的 0=周日 约定）。 */
const WEEKDAY_KEYS: readonly string[] = [
  "cron.describe.weekday.sun",
  "cron.describe.weekday.mon",
  "cron.describe.weekday.tue",
  "cron.describe.weekday.wed",
  "cron.describe.weekday.thu",
  "cron.describe.weekday.fri",
  "cron.describe.weekday.sat",
];

/**
 * 星期名按数字取包内文案；越界索引返回空串。
 *
 * 源实现直接取 `days[index]`，越界得到 undefined，join 后同样是空串，此处保持该语义
 * （不能退化成返回 key，否则「0 9 * * 7」这类越界输入会输出未翻译的键名）。
 */
function weekdayLabel(index: number, t: CronTranslate): string {
  const key: string | undefined = WEEKDAY_KEYS[index];
  return key ? t(key) : "";
}

/** 12 小时制时段词：中文模板放在时间之前，英文模板放在时间之后充当 AM / PM。 */
function periodLabel(hour: number, t: CronTranslate): string {
  if (hour < 12) return t("cron.describe.periodMorning");
  if (hour === 12) return t("cron.describe.periodNoon");
  return t("cron.describe.periodAfternoon");
}

/** 根据 cron 表达式返回人类可读的描述，所有文案经 t 取自包内字典；无法识别的表达式返回 null。 */
export function describeCron(cron: string, t: CronTranslate): string | null {
  const match = Object.entries(PRESETS).find(([, v]) => v === cron.trim());
  if (match) return t(`cron.presets.${match[0]}`);

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [min, hour, day, month, weekday] = parts;

  if (min.startsWith("*/")) {
    return t("cron.describe.everyNMinutes", { minutes: min.slice(2) });
  }

  if (hour !== "*" && day === "*" && month === "*" && weekday === "*") {
    const h = Number.parseInt(hour, 10);
    if (!Number.isNaN(h)) {
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const minStr = min === "*" ? "" : `:${min.padStart(2, "0")}`;
      return t("cron.describe.daily", { period: periodLabel(h, t), time: `${h12}${minStr}` });
    }
  }

  if (hour !== "*" && day === "*" && month === "*" && weekday !== "*") {
    const h = Number.parseInt(hour, 10);
    if (!Number.isNaN(h) && /^[\d,-]+$/.test(weekday)) {
      const dayNums = weekday.includes("-") ? [weekday] : weekday.split(",");
      const dayNames = dayNums.flatMap((d) => {
        if (d.includes("-")) {
          const [s, e] = d.split("-").map(Number);
          return Array.from({ length: e - s + 1 }, (_, i) => weekdayLabel(s + i, t));
        }
        return [weekdayLabel(Number(d), t)];
      });
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const minStr = min === "*" ? "" : `:${min.padStart(2, "0")}`;
      return t("cron.describe.weekly", {
        days: dayNames.join(t("cron.describe.weekdaySeparator")),
        period: periodLabel(h, t),
        time: `${h12}${minStr}`,
      });
    }
  }

  if (hour !== "*" && day !== "*" && month === "*" && weekday === "*") {
    const h = Number.parseInt(hour, 10);
    const d = Number.parseInt(day, 10);
    if (!Number.isNaN(h) && !Number.isNaN(d)) {
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const minStr = min === "*" ? "" : `:${min.padStart(2, "0")}`;
      return t("cron.describe.monthly", { day: d, period: periodLabel(h, t), time: `${h12}${minStr}` });
    }
  }

  if (hour !== "*" && day !== "*" && month !== "*" && weekday === "*") {
    const h = Number.parseInt(hour, 10);
    const d = Number.parseInt(day, 10);
    const m = Number.parseInt(month, 10);
    if (!Number.isNaN(h) && !Number.isNaN(d) && !Number.isNaN(m)) {
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const minStr = min === "*" ? "" : `:${min.padStart(2, "0")}`;
      return t("cron.describe.yearly", { month: m, day: d, period: periodLabel(h, t), time: `${h12}${minStr}` });
    }
  }

  return null;
}

export interface CronEditorProps {
  value: string;
  timezone?: string;
  onChange: (cron: string) => void;
  error?: string;
}

/** 校验 cron 表达式；通过时返回 undefined，否则返回包内字典的错误文案。 */
function validateCron(value: string, timezone: string, t: CronTranslate): string | undefined {
  const parts = value.trim().split(/\s+/);
  if (!value.trim()) return t("cron.error.empty");
  if (parts.length !== 5) return t("cron.error.fieldCount");
  try {
    parseExpression(value, timezone.trim() ? { tz: timezone.trim() } : undefined);
    return;
  } catch {
    return t("cron.error.invalid");
  }
}

export function CronEditor({ value, timezone = "", onChange, error }: CronEditorProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [editingCustom, setEditingCustom] = useState(false);
  const [debouncedError, setDebouncedError] = useState<string>();

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedError(validateCron(value, timezone, t)), 400);
    return () => clearTimeout(timer);
  }, [value, timezone, t]);

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

  const displayError = error ?? debouncedError;

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
              className={`h-7 flex-1 font-mono text-xs ${displayError ? "border-destructive" : ""}`}
            />
          </div>
        </div>
        {displayError && <p className="text-xs text-destructive">{displayError}</p>}
      </div>
    </div>
  );
}
