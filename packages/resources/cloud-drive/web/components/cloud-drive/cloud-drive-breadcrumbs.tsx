import { ChevronRight } from "lucide-react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { CLOUD_DRIVE_NS } from "../../i18n/namespace";
import type { CloudDriveBreadcrumb } from "../../types/cloud-drive";

interface CloudDriveBreadcrumbsProps {
  /** 从根目录到当前目录的路径；空数组表示当前就是根目录。 */
  trail: readonly CloudDriveBreadcrumb[];
  /** 点击任意层级；`null` 表示回到根目录。 */
  onNavigate: (parentId: string | null) => void;
}

/** 面包屑：根目录 + 逐级目录，当前层不可再点。 */
export function CloudDriveBreadcrumbs({ trail, onNavigate }: CloudDriveBreadcrumbsProps) {
  const { t } = useTranslation(CLOUD_DRIVE_NS);

  return (
    <nav aria-label={t("breadcrumb.label")} className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
      <button
        type="button"
        onClick={() => onNavigate(null)}
        className="rounded-sm px-1 py-0.5 text-text-muted transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {t("breadcrumb.root")}
      </button>
      {trail.map((node, index) => {
        const isCurrent = index === trail.length - 1;
        return (
          <Fragment key={node.id ?? "root"}>
            <ChevronRight className="size-4 shrink-0 text-text-dim" aria-hidden />
            {isCurrent ? (
              <span aria-current="page" className="max-w-60 truncate px-1 py-0.5 font-medium text-foreground">
                {node.name}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate(node.id)}
                className="max-w-60 truncate rounded-sm px-1 py-0.5 text-text-muted transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {node.name}
              </button>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
