/**
 * 工单标签：chips 行 + 内联多选编辑区（`Checkbox` 行，不用 `Popover`——标签项通常不多，内联键盘路径更短，
 * 也更容易在无覆盖层环境里被真实驱动）。
 *
 * 四条口径：
 * 1. **chips 只显示服务端事实**（工单快照的 `labels`），勾选草稿只存在于编辑区。因此不存在「乐观更新后回滚」
 *    这一步——失败时用户看到旧集合、勾选原样保留，再点保存即可（复用同一把键）；
 * 2. 颜色是上游自由字段：后端（Forgejo → `TicketLabelViewSchema`）给的是**裸十六进制**（服务端已把 `#` 归一去掉），
 *    前端两种形态都收、渲染时统一补 `#`，其余值直接忽略（不猜、不修、不回退成灰点，否则界面上会出现一个看起来有含义的颜色）；
 * 3. 目录为空时不显示保存按钮：没有可勾的项，保存只会提交一个空集合，那是清空标签，不是用户此刻的意图；
 * 4. 冲突（409）由 `use-ticket-labels` 自动刷新一次（单值动作口径，裁定三.20）：本组件不为它留手动入口，
 *    版本一变草稿就回到服务端集合，用户重新勾选即表达新意图。
 */

import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import { Checkbox } from "@fenix/ui-components/ui/checkbox";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { RefreshCw, Tags } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TicketLabel } from "../../../api/tickets";
import type { TicketLabelsState } from "../../../hooks/use-ticket-labels";
import { LABEL_MAX_COUNT } from "../../../hooks/use-ticket-labels";
import { TICKETS_NS } from "../../../i18n/namespace";

/**
 * 上游颜色的合法形态（`rgb` / `rrggbb` / 带 alpha 的 4/8 位，大小写不限，`#` 可有可无）。
 * 后端视图只产出裸十六进制，前端合同 §6.2 的 `#` 形态是端点冻结前的旧口径。
 */
const LABEL_COLOR_PATTERN = /^#?[0-9a-fA-F]{3,8}$/;

export interface TicketLabelsEditorProps {
  labels: TicketLabelsState;
  /** 工单当前的标签（服务端事实），chips 只渲染它。 */
  current: TicketLabel[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 有待确认的写、或别的写动作进行中。 */
  disabled: boolean;
}

export function TicketLabelsEditor({ labels, current, open, onOpenChange, disabled }: TicketLabelsEditorProps) {
  const { t } = useTranslation(TICKETS_NS);
  const atLimit = labels.draftIds.length >= LABEL_MAX_COUNT;
  const catalogEmpty = !labels.catalogLoading && labels.catalogError === undefined && labels.catalog.length === 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {current.length === 0 ? (
          <span className="text-xs text-text-dim">{t("labels.none")}</span>
        ) : (
          current.map((label) => (
            <Badge key={label.id} variant="outline">
              <LabelColorDot color={label.color} />
              {label.name}
            </Badge>
          ))
        )}
        <Button aria-expanded={open} disabled={disabled} onClick={() => onOpenChange(!open)} size="sm" variant="ghost">
          <Tags className="size-3.5" />
          {t("labels.edit")}
        </Button>
      </div>

      {open ? (
        <div className="rounded-md border border-border bg-surface-1 p-3">
          {labels.catalogLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-5 w-52" />
              <Skeleton className="h-5 w-36" />
            </div>
          ) : labels.catalogError !== undefined ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary" role="alert">
              <span>{t("labels.loadFailed")}</span>
              <Button
                disabled={labels.catalogLoading}
                onClick={labels.retryCatalog}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshCw className="size-3.5" />
                {t("loadState.retry")}
              </Button>
            </div>
          ) : catalogEmpty ? (
            <p className="text-xs text-text-dim">{t("labels.empty")}</p>
          ) : (
            <>
              <div aria-label={t("labels.edit")} className="flex flex-col" role="group">
                {labels.catalog.map((label) => {
                  const checked = labels.draftIds.includes(label.id);
                  const inputId = `ticket-label-${label.id}`;
                  // 到上限后只禁用**未勾选**的行：已勾选的必须还能取消，否则用户会被自己点满的选择锁住。
                  const rowDisabled = disabled || (atLimit && !checked);
                  return (
                    <label
                      className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
                      htmlFor={inputId}
                      key={label.id}
                    >
                      <Checkbox
                        aria-label={label.name}
                        checked={checked}
                        disabled={rowDisabled}
                        id={inputId}
                        onCheckedChange={() => labels.toggle(label.id)}
                      />
                      <LabelColorDot color={label.color} />
                      <span className="min-w-0">
                        <span className="block truncate">{label.name}</span>
                        {label.description === null ? null : (
                          <span className="block truncate text-xs text-text-muted">{label.description}</span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  disabled={disabled || labels.saving || !labels.dirty}
                  onClick={() => {
                    void labels.save();
                  }}
                  size="sm"
                  type="button"
                >
                  {t("labels.save")}
                </Button>
                {atLimit ? <span className="text-xs text-text-dim">{t("labels.maxCount")}</span> : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 标签颜色圆点：形态合法才渲染，非法值忽略（上游自由字段，不猜也不修正）。 */
function LabelColorDot({ color }: { color: string | null }) {
  if (color === null || !LABEL_COLOR_PATTERN.test(color)) return <span className="size-2" />;
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-full"
      // 数据驱动的内联色（唯一允许的例外，见裁定三.18）：值来自上游，无法枚举进 Tailwind 类名。
      // 后端给的是裸十六进制，CSS 需要 `#` 前缀，这里补齐。
      style={{ backgroundColor: color.startsWith("#") ? color : `#${color}` }}
    />
  );
}
