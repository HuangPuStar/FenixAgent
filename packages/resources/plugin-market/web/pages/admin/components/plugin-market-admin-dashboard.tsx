// plugin-market-admin-dashboard.tsx — 管理台插件市场面板（列表 / 详情 / 写动作编排）
//
// 它回答的问题与浏览面（`../../agent-panel/pages/plugin-market-page.tsx`）不同，因此是两个容器而不是一个带开关
// 的容器：
//   1. **凭据**：这里走 `/api/system/plugin-market/*`（系统 master key）；凭据失效（401 / 403）要清掉 key 并把
//      人送回门，浏览面则是给一个「无权查看」的稳定结论页。
//   2. **口径**：列表是全量的（含整包下架的条目），筛选多一档「已下架」。
//   3. **写入口**：发布（预览 → 确认两步）、下架与恢复（二次确认）都在这里。
//
// 展示件仍然共用（`web/components/plugin-market-detail`）：同一个条目对谁都是市场里冻结的同一份快照，
// 「控制台看到的」与「管理台看到的」不该有第二份实现。
//
// 状态归属：查询词、范围、选中项与两个弹窗开关都留在本组件——它们跨弹窗与列表刷新存活（关掉发布弹窗再打开，
// 用户不该发现自己被切回了第一条）。请求编排同理不拆 hook：本文件只有一个列表、一个详情与一个写动作，拆出去
// 只是把同一段状态机切成两半。

import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { Button } from "@fenix/ui-components/ui/button";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { PackagePlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { systemPluginMarketApi } from "../../../api/system-plugin-market";
import type { PluginPublicationChange } from "../../../api/system-plugin-market-types";
import { PLUGIN_MARKET_NS } from "../../../i18n/namespace";
import {
  changeToastKey,
  filterAdminPackages,
  type PluginAdminCatalogScope,
} from "../../../lib/plugin-market-admin-utils";
import { isAccessDeniedCode, isUnauthorizedError, resolveSelectedPackage } from "../../../lib/plugin-market-utils";
import { PluginMarketAdminCatalog } from "./plugin-market-admin-catalog";
import { PluginMarketPublishDialog } from "./plugin-market-publish-dialog";

/**
 * 待确认的写动作：下架与恢复共用一套确认流程，只有文案与请求不同。
 *
 * 定位符在**点击那一刻**就捕获，不在确认时再从当前选中项推：弹窗开着的时候选中项理论上仍可被上层改动，
 * 而「确认的是哪一个版本」必须与用户点的那一行严格一致。
 */
type PendingAction = { kind: "unpublish" | "restore"; packageName: string; exactVersion: string };

export function PluginMarketAdminDashboard({ onAuthFailure }: { onAuthFailure: () => void }) {
  const { t } = useTranslation(PLUGIN_MARKET_NS);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<PluginAdminCatalogScope>("all");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  // 发布弹窗的表单与流程态由 `key` 重置（§4.2 / §4.3）：每次**打开**换一个 `key` = 强制重挂载 = 全新表单实例
  // 与全新预览态。关闭时不动 `key`，弹窗内容留在树上走完退出动画。
  const [publishKey, setPublishKey] = useState(0);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [writing, setWriting] = useState(false);

  const catalog = useRequest(() => unwrap(systemPluginMarketApi.listAll()), {
    onError: (error) => {
      console.error(t("toast.loadListFailed"), error);
      // 凭据失效不是「加载失败」：门上有明确提示，这里再弹一次只会让人以为是市场本身出了问题。
      if (isUnauthorizedError(error)) onAuthFailure();
      else toast.error(t("toast.loadListFailed"));
    },
  });
  const packages = catalog.data?.packages ?? [];
  // 过滤只算一次：目录渲染、选中项解析与详情请求都用这一份（三处各算一次会让它们对「当前可见集合」产生分歧）。
  const filtered = filterAdminPackages(packages, query, scope);
  const selected = resolveSelectedPackage(filtered, selectedSlug);

  const detail = useRequest((slug: string) => unwrap(systemPluginMarketApi.get(slug)), {
    manual: true,
    onError: (error) => {
      console.error(t("toast.loadDetailFailed"), error);
      if (isUnauthorizedError(error)) onAuthFailure();
    },
  });

  // 选中项变化（含过滤后回退到第一条、列表刷新后同一 slug 仍在）才重新拉详情：依赖只有 slug，
  // 列表刷新导致的对象换新不会触发第二次请求。`run` 的引用稳定由 ahooks 保证。
  const detailSlug = selected?.slug ?? null;
  useEffect(() => {
    if (detailSlug) void detail.run(detailSlug);
  }, [detailSlug, detail.run]);

  /** 写成功后的统一收尾：提示 + 列表与详情一起刷新 + 选中刚写入的条目。 */
  const settleWrite = (change: PluginPublicationChange) => {
    toast.success(t(changeToastKey(change.action), { version: change.exactVersion }));
    setSelectedSlug(change.slug);
    catalog.refresh();
    // 详情用当前生效的 slug 重拉：写入可能改变该条目的展示快照（latest 指针移动）或下架水印。
    if (change.slug === detailSlug) detail.refresh();
  };

  const runPendingAction = async () => {
    if (!pending) return;
    const target = { packageName: pending.packageName, exactVersion: pending.exactVersion };
    setWriting(true);
    try {
      const response =
        pending.kind === "unpublish"
          ? await systemPluginMarketApi.unpublish(target)
          : await systemPluginMarketApi.restore(target);
      if (response.success && response.data) {
        setPending(null);
        settleWrite(response.data.change);
        return;
      }
      // 写路径不做 `unwrap`（发布路径的 409 冲突体要走同一条出口），因此凭据失效在这里是**信封里的码**：
      // 用 `instanceof ApiError` 那一层判断会漏掉，表现为「key 已失效，人却停在原地反复点」。
      if (isAccessDeniedCode(response.error?.code)) {
        setPending(null);
        onAuthFailure();
        return;
      }
      const fallback = pending.kind === "unpublish" ? t("toast.unpublishFailed") : t("toast.restoreFailed");
      console.error(fallback, response.error);
      toast.error(fallback);
    } finally {
      setWriting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">{t("admin.title")}</h1>
            <p className="mt-1 text-xs text-text-muted">{t("admin.subtitle")}</p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setPublishKey((key) => key + 1);
              setPublishOpen(true);
            }}
          >
            <PackagePlus className="size-4" />
            {t("btn.publish")}
          </Button>
        </header>

        <PluginMarketAdminCatalog
          packages={packages}
          filtered={filtered}
          loading={catalog.loading}
          error={catalog.error}
          query={query}
          scope={scope}
          selectedSlug={selected?.slug ?? null}
          detail={detail.data?.package ?? null}
          detailLoading={detail.loading}
          detailError={detail.error}
          writing={writing}
          onQueryChange={setQuery}
          onScopeChange={setScope}
          onSelect={setSelectedSlug}
          onRetry={catalog.refresh}
          onDetailRetry={detail.refresh}
          onUnpublish={(packageName, exactVersion) => setPending({ kind: "unpublish", packageName, exactVersion })}
          onRestore={(packageName, exactVersion) => setPending({ kind: "restore", packageName, exactVersion })}
        />
      </div>

      <PluginMarketPublishDialog
        key={publishKey}
        open={publishOpen}
        onOpenChange={setPublishOpen}
        onPublished={settleWrite}
        onAuthFailure={onAuthFailure}
      />

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending?.kind === "restore" ? t("dialog.restoreTitle") : t("dialog.unpublishTitle")}
        description={
          pending?.kind === "restore"
            ? t("dialog.restoreDescription", { version: pending.exactVersion })
            : t("dialog.unpublishDescription", { version: pending?.exactVersion ?? "" })
        }
        confirmLabel={pending?.kind === "restore" ? t("btn.restore") : t("btn.unpublish")}
        variant={pending?.kind === "unpublish" ? "destructive" : "default"}
        loading={writing}
        onConfirm={() => void runPendingAction()}
      />
    </div>
  );
}
