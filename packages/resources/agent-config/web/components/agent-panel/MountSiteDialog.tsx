import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { cn } from "@fenix/ui-components/lib/cn";
import { Button } from "@fenix/ui-components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@fenix/ui-components/ui/dialog";
import { unwrap } from "@fenix/web-runtime/api/request";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useRequest } from "ahooks";
import { Globe, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { agentSitesApi, type SiteApp } from "../../api/sites";
import { errorMessage } from "../../lib/error-message";

interface SiteOption {
  id: string;
  name: string;
  remoteAppId: string;
  description?: string | null;
}

interface MountSiteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentConfigId: string;
  /** 当前已绑定的 siteAppIds，用于在候选列表中过滤掉 */
  boundSiteAppIds: string[];
  /** 成功挂载后调用方触发 sites 重新拉取 */
  onMounted: () => void;
}

/**
 * MountSiteDialog —— chat 右侧 Sites tab "+" 按钮触发的挂载弹层。
 *
 * 打开时拉取组织内全部 site app，排除已绑定的，剩余作为可挂载候选。
 * 多选 + 确认后串行调用 bindSite（PK 联合唯一保证幂等，并发场景无风险）。
 *
 * 不消费 agentSitesApi 内的 { success, data } 自动解包：agentSitesFetch 不解包，
 * 直接返回原始响应对象，需手动取 .data。
 *
 * 候选量预期很小（单组织通常 < 50），不做分页/搜索；候选为空时显示明确提示。
 */
export function MountSiteDialog({
  open,
  onOpenChange,
  agentConfigId,
  boundSiteAppIds,
  onMounted,
}: MountSiteDialogProps) {
  // `panelMode.*` 挂载弹窗键随台账 D4 迁入本包 `agents`；`confirmDialog.cancel` 的 owner 是
  // `@fenix/ui-components`（`ConfirmDialog` 的同名默认文案），故另取该包命名空间，不再借宿主字典。
  const { t } = useTranslation(NS.AGENTS);
  const { t: tUi } = useTranslation(NS.UI_COMPONENTS);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 每次 open 都重拉以保证最新（关闭期间可能新建过 site）
  const {
    data: rawData = [],
    loading,
    error: listError,
    refresh: refreshSites,
  } = useRequest(() => unwrap(agentSitesApi.list()), {
    ready: open,
    onError: (err) => {
      // 保留完整异常作诊断；失败块通过 listError 优先展示服务端错误信封的 message。
      console.error("[MountSiteDialog] 加载 site 列表失败", err);
    },
  });

  // 打开时重置选中状态
  useEffect(() => {
    if (open) setSelected(new Set());
  }, [open]);

  const options = useMemo<SiteOption[]>(() => {
    const data = rawData as SiteApp[];
    return data
      .map((item) => ({
        id: item.id,
        name: item.name,
        remoteAppId: item.remoteAppId,
        description: item.description,
      }))
      .filter((item) => item.id && item.remoteAppId);
  }, [rawData]);

  const candidates = options.filter((o) => !boundSiteAppIds.includes(o.id));

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // bindSite 提交：串行单点原子操作，避免并发写 PK 冲突；候选量小无需并行优化
  const { run: runBindSites, loading: submitting } = useRequest(
    async (ids: string[]) => {
      let failed = 0;
      // 第一条失败原因随结果一起回传：失败项可能只有一条，但用户看到的提示原先是一句固定文案，
      // 后端给出的原因就此丢掉（`console.error` 只有开发者在控制台能看到）。
      let firstError: string | null = null;
      for (const id of ids) {
        try {
          await unwrap(agentSitesApi.bindSite(agentConfigId, id));
        } catch (err) {
          failed++;
          firstError ??= errorMessage(err);
          console.error("[MountSiteDialog] 绑定 site 失败", { siteAppId: id, err });
        }
      }
      return { failed, ids, firstError };
    },
    {
      manual: true,
      onSuccess: ({ failed, ids, firstError }: { failed: number; ids: string[]; firstError: string | null }) => {
        if (failed === 0) {
          toast.success(t("panelMode.mountSuccess", { count: ids.length }));
          onMounted();
          onOpenChange(false);
        } else {
          // 部分失败也触发 reload 让用户看到实际生效项，并给出失败原因（服务端原文优先，取不到才用字典文案）
          onMounted();
          toast.error(firstError ?? t("panelMode.mountFailed"));
        }
      },
    },
  );

  const handleConfirm = () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    runBindSites(ids);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-120">
        <DialogHeader>
          <DialogTitle>{t("panelMode.mountDialogTitle")}</DialogTitle>
          <DialogDescription>{t("panelMode.mountDialogHint")}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              <span className="text-sm">...</span>
            </div>
          ) : listError ? (
            // 取数失败必须与「没有可挂载的站点」分开：失败时 `candidates` 同样是空的，
            // 照旧渲染会让用户以为自己组织里没有站点（§3.4），重试按 `ready: open` 重新拉取。
            <EmptyState
              icon={<TriangleAlert />}
              title={t("panelMode.sitesLoadFailed")}
              description={errorMessage(listError)}
              tone="danger"
              role="alert"
              action={{ label: t("panelMode.retry"), onClick: refreshSites, icon: <RefreshCw />, disabled: loading }}
            />
          ) : candidates.length === 0 ? (
            <p className="py-8 text-center text-sm text-text-muted">{t("panelMode.noAvailableSites")}</p>
          ) : (
            <div className="space-y-2 py-1">
              {candidates.map((item) => {
                const checked = selected.has(item.id);
                return (
                  <label
                    key={item.id}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm cursor-pointer transition-colors",
                      checked ? "border-primary/60 bg-primary/5" : "border-border-subtle hover:bg-surface-2/60",
                    )}
                  >
                    <div className="min-w-0 flex items-center gap-2">
                      <Globe className="h-3.5 w-3.5 flex-shrink-0 text-text-muted" />
                      <div className="min-w-0">
                        <p className="font-medium text-text-primary truncate">{item.name}</p>
                        <p className="text-xs text-text-muted truncate font-mono">{item.remoteAppId}</p>
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(item.id)}
                      className="h-4 w-4 flex-shrink-0"
                    />
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {tUi("confirmDialog.cancel")}
          </Button>
          <Button onClick={handleConfirm} disabled={submitting || selected.size === 0 || candidates.length === 0}>
            {submitting
              ? "..."
              : selected.size > 0
                ? t("panelMode.mountDialogConfirm", { count: selected.size })
                : t("panelMode.mountDialogConfirmNone")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
