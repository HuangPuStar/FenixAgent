import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import { Download, FolderOpen } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cloudDriveApi } from "../../api/cloud-drive";
import { CLOUD_DRIVE_NS } from "../../i18n/namespace";
import { fileTypeIcon } from "../../lib/file-kind";
import type { CloudDriveSearchFileResult, CloudDriveSearchSnippet } from "../../types/cloud-drive";

interface CloudDriveSearchResultProps {
  hit: CloudDriveSearchFileResult;
  /** 该行正在解析所在目录：禁用两个打开动作防连点。 */
  opening: boolean;
  onOpenLocation: (hit: CloudDriveSearchFileResult) => void;
}

/** 目录路径的紧凑面包屑：根目录固定为第一段，后续目录用斜杠分隔。 */
function directoryLabel(path: string, rootLabel: string): string {
  const directories = path.split("/").filter(Boolean).slice(0, -1);
  return directories.length > 0 ? `${rootLabel} / ${directories.join(" / ")}` : rootLabel;
}

/**
 * 多段片段的合并渲染：所有片段放进同一段，段间用「·」分隔，整段最多两行。
 *
 * 这样同一文件的多个命中不会把结果行撑成多段正文；命中区间只用于切片，文本节点由 React 转义。
 */
function SnippetParagraph({ snippets }: { snippets: CloudDriveSearchSnippet[] }) {
  const nodes: ReactNode[] = [];

  snippets.forEach((snippet, snippetIndex) => {
    if (snippetIndex > 0) nodes.push(" · ");
    if (snippet.leadingEllipsis) nodes.push("…");

    let cursor = 0;
    snippet.matches.forEach((match, matchIndex) => {
      const valid =
        match.start >= cursor && match.start >= 0 && match.end > match.start && match.end <= snippet.text.length;
      if (!valid) return;
      if (match.start > cursor) nodes.push(snippet.text.slice(cursor, match.start));
      nodes.push(
        <mark
          // biome-ignore lint/suspicious/noArrayIndexKey: 片段内区间顺序稳定且只做静态渲染
          key={`match-${snippetIndex}-${matchIndex}`}
          className="rounded-sm bg-yellow-200 px-0.5 font-medium text-inherit dark:bg-yellow-500/40"
        >
          {snippet.text.slice(match.start, match.end)}
        </mark>,
      );
      cursor = match.end;
    });

    if (cursor < snippet.text.length) nodes.push(snippet.text.slice(cursor));
    if (snippet.trailingEllipsis) nodes.push("…");
  });

  return <p className="line-clamp-2 text-xs leading-5 break-words text-text-muted">{nodes}</p>;
}

/** Google 式紧凑结果行：文件名、所在目录、最多 3 段高亮片段与两个行内动作。 */
export function CloudDriveSearchResult({ hit, opening, onOpenLocation }: CloudDriveSearchResultProps) {
  const { t } = useTranslation(CLOUD_DRIVE_NS);
  const Icon = fileTypeIcon(hit.kind, hit.name);

  return (
    <li className="flex items-start gap-2 py-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => onOpenLocation(hit)}
            disabled={opening}
            title={hit.name}
            className="min-w-0 truncate rounded-sm text-left text-sm font-medium text-foreground transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
          >
            {hit.name}
          </button>
          {hit.stale && (
            <Badge variant="secondary" className="shrink-0">
              {t("search.stale")}
            </Badge>
          )}
        </div>

        <p className="truncate text-xs text-text-dim" title={hit.path}>
          {directoryLabel(hit.path, t("breadcrumb.root"))}
        </p>

        {hit.snippets.length > 0 && <SnippetParagraph snippets={hit.snippets} />}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {hit.kind === "file" && (
          <Button asChild variant="ghost" size="icon-sm">
            <a
              href={cloudDriveApi.contentUrl(hit.fileId)}
              aria-label={t("actions.download")}
              title={t("actions.download")}
            >
              <Download aria-hidden />
            </a>
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("actions.openLocation")}
          title={t("actions.openLocation")}
          disabled={opening}
          onClick={() => onOpenLocation(hit)}
        >
          <FolderOpen aria-hidden />
        </Button>
      </div>
    </li>
  );
}
