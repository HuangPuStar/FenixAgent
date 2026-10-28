import { Progress } from "@fenix/ui-components/ui/progress";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { useTranslation } from "react-i18next";
import { CLOUD_DRIVE_NS } from "../../i18n/namespace";
import { formatBytes } from "../../lib/format";
import type { CloudDrivePrincipal } from "../../types/cloud-drive";

interface CloudDriveQuotaProps {
  principal: CloudDrivePrincipal | undefined;
  loading: boolean;
  /** 跟随界面语言；日期与数字都用它格式化。 */
  locale: string;
}

/** 配额条：已用 / 上限 + 上传预留；配额不可用时只显示一行说明，不阻塞文件浏览。 */
export function CloudDriveQuota({ principal, loading, locale }: CloudDriveQuotaProps) {
  const { t } = useTranslation(CLOUD_DRIVE_NS);

  if (!principal) {
    return loading ? (
      <div className="w-full max-w-sm space-y-1.5" aria-hidden>
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-2 w-full" />
      </div>
    ) : (
      <p className="text-xs text-text-dim">{t("page.quotaUnavailable")}</p>
    );
  }

  const { limitBytes, usedBytes, reservedBytes } = principal.quota;
  const percent = limitBytes > 0 ? Math.min(100, Math.round((usedBytes / limitBytes) * 100)) : 0;

  return (
    <div className="w-full max-w-sm space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs text-text-muted">
        <span>
          {t("page.quotaUsage", { used: formatBytes(usedBytes, locale), limit: formatBytes(limitBytes, locale) })}
        </span>
        {reservedBytes > 0 && (
          <span className="text-text-dim">
            {t("page.quotaReserved", { reserved: formatBytes(reservedBytes, locale) })}
          </span>
        )}
      </div>
      <Progress value={percent} aria-label={t("a11y.quotaProgress")} />
    </div>
  );
}
