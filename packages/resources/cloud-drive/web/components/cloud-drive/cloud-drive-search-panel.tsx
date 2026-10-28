import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { FolderOpen, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CLOUD_DRIVE_NS } from "../../i18n/namespace";
import { cloudDriveErrorMessage } from "../../lib/errors";
import type { CloudDriveSearchHit, CloudDriveSearchPage } from "../../types/cloud-drive";

interface CloudDriveSearchPanelProps {
  term: string;
  results: CloudDriveSearchPage | undefined;
  loading: boolean;
  error: unknown;
  /** 正在解析「所在目录」的命中文件 ID；该行按钮置灰防连点。 */
  openingId: string | null;
  onClear: () => void;
  onRetry: () => void;
  onOpenLocation: (hit: CloudDriveSearchHit) => void;
}

/** 路径的最后一段作为标题；搜索命中只给绝对路径，没有独立名称字段。 */
function baseName(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/** 搜索结果：路径、片段、陈旧标记与「回到所在目录」。 */
export function CloudDriveSearchPanel({
  term,
  results,
  loading,
  error,
  openingId,
  onClear,
  onRetry,
  onOpenLocation,
}: CloudDriveSearchPanelProps) {
  const { t } = useTranslation(CLOUD_DRIVE_NS);

  if (!term) return null;

  return (
    <section aria-label={t("a11y.searchResults")} className="space-y-3">
      <header className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-muted">
          {results && !loading ? t("search.resultCount", { count: results.items.length }) : null}
        </p>
        <Button variant="ghost" size="xs" onClick={onClear}>
          <X aria-hidden />
          {t("actions.clearSearch")}
        </Button>
      </header>

      {loading ? (
        <div className="flex justify-center py-8">
          <Spinner variant="inline" label={t("search.searching")} />
        </div>
      ) : error ? (
        <EmptyState
          tone="danger"
          role="alert"
          icon={<Search aria-hidden />}
          title={t("states.loadFailed")}
          description={cloudDriveErrorMessage(error, (key) => String(t(key)))}
          action={{ label: t("actions.retry"), onClick: onRetry }}
        />
      ) : !results || results.items.length === 0 ? (
        <EmptyState
          icon={<Search aria-hidden />}
          title={t("states.noSearchResults")}
          description={t("states.noSearchResultsHint")}
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {results.items.map((hit) => (
            <li key={`${hit.fileId}-${hit.returnedVersionId ?? "current"}`} className="space-y-1 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium" title={hit.path}>
                    {baseName(hit.path)}
                  </p>
                  <p className="truncate text-xs text-text-dim" title={hit.path}>
                    {hit.path}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {hit.stale && <Badge variant="secondary">{t("search.stale")}</Badge>}
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => onOpenLocation(hit)}
                    disabled={openingId === hit.fileId}
                  >
                    <FolderOpen aria-hidden />
                    {t("actions.openLocation")}
                  </Button>
                </div>
              </div>
              {hit.snippet && <p className="text-xs whitespace-pre-line text-text-muted">{hit.snippet}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
