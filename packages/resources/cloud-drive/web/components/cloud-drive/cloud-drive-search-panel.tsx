import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CLOUD_DRIVE_NS } from "../../i18n/namespace";
import { cloudDriveErrorMessage } from "../../lib/errors";
import type { CloudDriveSearchFileResult, CloudDriveSearchResultPage } from "../../types/cloud-drive";
import { CloudDriveSearchResult } from "./cloud-drive-search-result";

interface CloudDriveSearchPanelProps {
  term: string;
  results: CloudDriveSearchResultPage | undefined;
  loading: boolean;
  error: unknown;
  /** 正在解析「所在目录」的命中文件 ID；该行动作置灰防连点。 */
  openingId: string | null;
  onClear: () => void;
  onRetry: () => void;
  onOpenLocation: (hit: CloudDriveSearchFileResult) => void;
}

/** 搜索结果：Google 式紧凑单列，一个文件一行，命中词在片段内高亮。 */
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

  const fileCount = results?.fileCount ?? results?.items.length ?? 0;
  const matchCount = results?.matchCount ?? 0;
  let summary: string | null = null;
  if (results && !loading && !error && fileCount > 0) {
    summary =
      matchCount > 0
        ? t("search.summary", { files: fileCount, matches: matchCount })
        : t("search.summaryNoMatches", { files: fileCount });
  }

  return (
    <section aria-label={t("a11y.searchResults")} className="space-y-2">
      <header className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-muted">{summary}</p>
        <Button variant="ghost" size="xs" onClick={onClear}>
          <X aria-hidden />
          {t("actions.clearSearch")}
        </Button>
      </header>

      {loading ? (
        <div className="space-y-2 py-1" role="status" aria-live="polite">
          <span className="sr-only">{t("search.searching")}</span>
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="space-y-1.5 py-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/4" />
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
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
        <ul className="divide-y border-y">
          {results.items.map((hit) => (
            <CloudDriveSearchResult
              key={hit.fileId}
              hit={hit}
              opening={openingId === hit.fileId}
              onOpenLocation={onOpenLocation}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
