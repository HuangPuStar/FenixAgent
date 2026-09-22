import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { getStatusTone } from "@fenix/ui-components/config/StatusBadge";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { StatusDot } from "@fenix/ui-components/ui/status-dot";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { BookOpen, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { KnowledgeBaseInfo } from "../../../types/knowledge";
import { KnowledgeLoadFailure } from "./agent-knowledge-load-failure";
import { KB_STATUS_TONES } from "./knowledge-status";

interface AgentKnowledgeDirectoryProps {
  items: KnowledgeBaseInfo[];
  selectedId: string | null;
  loading: boolean;
  error: unknown;
  canManage: boolean;
  onRetry: () => void;
  onSelect: (item: KnowledgeBaseInfo) => void;
  onDelete: (item: KnowledgeBaseInfo) => void;
}

export function AgentKnowledgeDirectory(props: AgentKnowledgeDirectoryProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  return (
    <aside className="knowledge-directory">
      <header>
        <strong>{t("directory.title")}</strong>
        <span>{props.items.length}</span>
      </header>
      {props.loading ? (
        <div
          className="knowledge-directory__loading"
          role="status"
          aria-busy="true"
          aria-label={t("directory.loading")}
        >
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      ) : props.error ? (
        <KnowledgeLoadFailure
          error={props.error}
          title={t("loadError")}
          onRetry={props.onRetry}
          className="px-2 py-8"
        />
      ) : props.items.length === 0 ? (
        <EmptyState className="px-2 py-8" title={t("emptyMessage")} />
      ) : (
        <nav aria-label={t("directory.title")}>
          {props.items.map((item) => {
            const active = item.id === props.selectedId;
            const unavailable = item.remoteExists === false;
            return (
              <div
                key={item.id}
                className={`knowledge-directory-item ${active ? "is-active" : ""} ${unavailable ? "is-unavailable" : ""}`}
              >
                <button
                  type="button"
                  aria-current={active ? "page" : undefined}
                  aria-disabled={unavailable}
                  onClick={() => props.onSelect(item)}
                >
                  <span className="knowledge-directory-item__icon">
                    <BookOpen />
                  </span>
                  <span className="knowledge-directory-item__copy">
                    <strong>{item.name}</strong>
                    <small>
                      {/* 纯装饰圆点：不传 `label` 故整块 `aria-hidden`（旁边的资源数已承担可读信息），
                          6px 装饰尺度由 `size-1.5` 覆盖库默认的 8px；色调查本包唯一词表。 */}
                      <StatusDot tone={getStatusTone(item.status, KB_STATUS_TONES)} className="size-1.5" />
                      {t("card.resourcesUnit", { count: item.resourcesCount })}
                    </small>
                  </span>
                </button>
                {unavailable && props.canManage && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="text-red-500"
                    aria-label={t("btn.delete")}
                    onClick={() => props.onDelete(item)}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            );
          })}
        </nav>
      )}
    </aside>
  );
}
