/**
 * 工具行的行内详情：diff / 输出文本。
 *
 * 与参数弹窗分工：这里只呈现执行结果的可读形态（变更行、命令输出、读取片段），
 * 原始入参出参 JSON 仍由 `ToolCallDialog` 承载。
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { cn } from "../../lib/cn";
import { computeLineDiff } from "../lib/simple-diff";
import type { ToolDetail, ToolDiffFile } from "./tool-detail-model";

/** 单行前缀；删除/新增/上下文各用固定符号，便于复制与扫读。 */
function linePrefix(type: "context" | "add" | "remove"): string {
  if (type === "add") return "+";
  if (type === "remove") return "-";
  return " ";
}

/**
 * 为同内容重复行生成稳定且唯一的 key。
 *
 * diff 行本身没有 id，直接用下标会触发 `noArrayIndexKey`；这里按「内容 + 出现序号」编号，
 * 内容与顺序相同则 key 相同，重复空行/重复代码行也不会冲突。
 */
function withOccurrenceKeys<T>(items: readonly T[], baseOf: (item: T) => string): { key: string; item: T }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = baseOf(item);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return { key: `${base}:${occurrence}`, item };
  });
}

function DiffFileView({ file }: { file: ToolDiffFile }) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const diff = useMemo(() => computeLineDiff(file.oldText, file.newText), [file.oldText, file.newText]);

  return (
    <div data-slot="chat-tool-call-detail-diff">
      <div className="flex min-w-0 items-baseline gap-2 border-b border-border/40 px-2 py-1">
        <span className="min-w-0 truncate font-mono text-3xs text-slate-500" title={file.path}>
          {file.path}
        </span>
        <span className="ml-auto flex shrink-0 items-baseline gap-1.5 text-3xs tabular-nums">
          <span className="text-emerald-600">+{diff.added}</span>
          <span className="text-red-500">−{diff.removed}</span>
        </span>
      </div>
      <div className="max-h-64 overflow-auto py-1 font-mono text-3xs leading-5">
        {diff.lines.length === 0 ? (
          <div className="px-2 text-slate-400">{t("chat.components.toolCallRow.noChanges")}</div>
        ) : (
          withOccurrenceKeys(diff.lines, (line) => `${line.type}:${line.hiddenCount ?? line.text}`).map(
            ({ key, item: line }) =>
              line.type === "ellipsis" ? (
                <div key={key} className="px-2 text-slate-400" data-slot="chat-tool-call-detail-ellipsis">
                  … {t("chat.components.toolCallRow.diffUnchanged", { count: line.hiddenCount ?? 0 })}
                </div>
              ) : (
                <div
                  key={key}
                  className={cn(
                    "whitespace-pre px-2",
                    line.type === "add" && "bg-emerald-50 text-emerald-700",
                    line.type === "remove" && "bg-red-50 text-red-600",
                    line.type === "context" && "text-slate-500",
                  )}
                >
                  <span className="select-none">{linePrefix(line.type)}</span>
                  {line.text === "" ? " " : line.text}
                </div>
              ),
          )
        )}
      </div>
    </div>
  );
}

/** 工具行内详情视图；数据由 `buildToolDetail` 纯函数投影，本组件只负责排版。 */
export function ToolCallDetail({ detail }: { detail: ToolDetail }) {
  const { t } = useTranslation(UI_COMPONENTS_NS);

  if (detail.type === "diff") {
    return (
      <div className="min-w-0 divide-y divide-border/40" data-slot="chat-tool-call-detail">
        {withOccurrenceKeys(detail.files, (file) => file.path).map(({ key, item: file }) => (
          <DiffFileView key={key} file={file} />
        ))}
      </div>
    );
  }

  const range =
    detail.lineStart === undefined
      ? undefined
      : detail.lineEnd === undefined || detail.lineEnd === detail.lineStart
        ? `${detail.lineStart}`
        : `${detail.lineStart}–${detail.lineEnd}`;

  return (
    <div className="min-w-0" data-slot="chat-tool-call-detail">
      {(detail.path || range) && (
        <div className="flex min-w-0 items-baseline gap-2 border-b border-border/40 px-2 py-1">
          {detail.path && (
            <span className="min-w-0 truncate font-mono text-3xs text-slate-500" title={detail.path}>
              {detail.path}
            </span>
          )}
          {range && (
            <span className="ml-auto shrink-0 text-3xs text-slate-400">
              {t("chat.toolNarrator.common.lineRange", { range })}
            </span>
          )}
        </div>
      )}
      <div className="max-h-64 overflow-auto py-1">
        <pre className="whitespace-pre px-2 font-mono text-3xs leading-5 text-slate-600">{detail.text}</pre>
      </div>
      {detail.truncated && (
        <div className="px-2 pb-1 text-3xs text-slate-400">{t("chat.components.toolCallRow.truncated")}</div>
      )}
    </div>
  );
}
