import { BookOpen, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NS } from "@/src/i18n";
import type { KnowledgeBaseInfo } from "../../../types/knowledge";

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

function statusClass(status: string): string {
  if (status === "ready") return "is-ready";
  if (["processing", "pending", "indexing"].includes(status)) return "is-processing";
  if (status === "error") return "is-error";
  return "";
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
        <div className="knowledge-directory__state" role="alert">
          <p>{props.error instanceof Error ? props.error.message : t("loadError")}</p>
          <Button size="sm" variant="outline" onClick={props.onRetry}>
            <RefreshCw />
            {t("actions.retry")}
          </Button>
        </div>
      ) : props.items.length === 0 ? (
        <div className="knowledge-directory__state">{t("emptyMessage")}</div>
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
                      <i className={statusClass(item.status)} />
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
