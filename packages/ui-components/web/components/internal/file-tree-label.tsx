import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { formatDateTime, formatFileModifiedTime, formatFileSize } from "../../lib/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import type { ParsedFileNode } from "../file-tree-model";

/** Tooltip 绑定树行，让 Arborist 的 Tab/方向键焦点和鼠标悬停共用完整信息。 */
export function FileTreeTooltip({ node, children }: { node: ParsedFileNode; children: ReactElement }) {
  const { t, i18n } = useTranslation(UI_COMPONENTS_NS);
  const size = formatFileSize(node.size);
  const fullTime =
    node.modifiedAt && node.modifiedAt > 0 ? formatDateTime(node.modifiedAt, { locale: i18n.language }) : "—";
  const exactSize =
    node.size !== undefined && Number.isFinite(node.size) && node.size >= 0
      ? t("fileTree.byteCount", { bytes: new Intl.NumberFormat(i18n.language).format(node.size) })
      : "—";

  return (
    <Tooltip>
      <TooltipTrigger
        asChild
        aria-label={
          node.isDir
            ? node.name
            : t("fileTree.metadataSummary", { name: node.name, size: exactSize, modifiedAt: fullTime })
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-80 space-y-1 py-2">
        <p className="break-all font-medium">{node.name}</p>
        {!node.isDir && (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
            <dt className="text-text-secondary">{t("fileTree.fileSize")}</dt>
            <dd>
              {size} {exactSize === "—" ? null : `(${exactSize})`}
            </dd>
            <dt className="text-text-secondary">{t("fileTree.modifiedAt")}</dt>
            <dd>{fullTime}</dd>
          </dl>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

import type { ReactElement } from "react";

/** 文件双行标签；目录保留单行，完整信息由所属树行提供。 */
export function FileTreeLabel({ node, now }: { node: ParsedFileNode; now: number }) {
  const { i18n } = useTranslation(UI_COMPONENTS_NS);
  return (
    <span className="block w-0 min-w-0 flex-auto text-left">
      <span className="block truncate text-sm leading-5">{node.name}</span>
      {!node.isDir && (
        <span className="flex min-w-0 items-center gap-1 whitespace-nowrap text-xs leading-4 text-text-muted">
          <span className="shrink-0 tabular-nums">{formatFileSize(node.size)}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{formatFileModifiedTime(node.modifiedAt, { locale: i18n.language, now })}</span>
        </span>
      )}
    </span>
  );
}
