// plugin-market-page.tsx — 插件市场目录页的容器（数据 + 写动作编排）
//
// 与 mcp / skill 目录页同构：容器持有请求状态与对话框开关，展示骨架（`PluginMarketCatalog`）只收 props。
// 这里承担四件事：
//
// 1. **列表与详情分两次请求**（后端 `/packages` 只给概要视图，详情含版本历史），详情的定位符取自
//    `resolveSelectedPackage` 的解析结果——与左侧高亮用同一个函数，避免「高亮 A、右侧是 B」。
// 2. **写动作不做 `unwrap`**：发布路径的 409 `PREVIEW_CHANGED` 必须把新快照交给弹窗（见 api 模块的文件头），
//    因此这里显式判断 `success`，失败时既提示又不丢冲突信息。
// 3. **写成功后列表与详情一起刷新**：写入会改变顺序与展示快照，只刷新一处会让界面停留在旧状态。
// 4. **不做 `dispatchConfigChange`**：市场条目不是 Agent 的运行时配置，改它不影响任何 agent 进程的启动
//    参数（对比 skill / mcp 的写入会改变 agent 可用的能力清单）。多广播一次会让无关的 Chat 面板重载配置。
//
// 弹窗、确认对话框各自独立成文件：发布（两步 + 冲突重确认）与下架/恢复（二次确认）是两种不同的交互，
// 合并到一个文件只会让两段状态机互相牵扯。

import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { pluginMarketApi } from "../../../api/plugin-market";
import type { PluginCatalogScope, PluginPublicationChange } from "../../../api/plugin-market-types";
import { PLUGIN_MARKET_NS } from "../../../i18n/namespace";
import { PluginMarketCatalog } from "./plugin-market-catalog";
import { PluginMarketPublishDialog } from "./plugin-market-publish-dialog";
import { changeToastKey, resolveSelectedPackage } from "./plugin-market-utils";

/** 待确认的写动作：下架与恢复共用一套确认流程，只有文案与请求不同。 */
type PendingAction = {
  kind: "unpublish" | "restore";
  packageName: string;
  exactVersion: string;
};

export function PluginMarketPage() {
  const { t } = useTranslation(PLUGIN_MARKET_NS);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<PluginCatalogScope>("all");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [writing, setWriting] = useState(false);

  const catalog = useRequest(() => unwrap(pluginMarketApi.list()), {
    onError: (error) => {
      console.error(t("toast.loadListFailed"), error);
      toast.error(t("toast.loadListFailedWith", { message: error.message }));
    },
  });
  const packages = catalog.data?.packages ?? [];
  const canPublish = catalog.data?.canPublish ?? false;
  const selected = resolveSelectedPackage(packages, query, scope, selectedSlug);

  const detail = useRequest((slug: string) => unwrap(pluginMarketApi.get(slug)), {
    manual: true,
    onError: (error) => {
      console.error(t("toast.loadDetailFailed"), error);
    },
  });

  // 选中项变化（含过滤后回退到第一条、列表刷新后同一 slug 仍在）才重新拉详情：依赖只有 slug，
  // 列表刷新导致的对象换新不会触发第二次请求。`run` 的引用稳定由 ahooks 保证（同款写法见
  // `model-management` 的 `AdminModelGatewayPage`）。
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
        pending.kind === "unpublish" ? await pluginMarketApi.unpublish(target) : await pluginMarketApi.restore(target);
      if (response.success && response.data) {
        setPending(null);
        settleWrite(response.data.change);
        return;
      }
      const fallback = pending.kind === "unpublish" ? t("toast.unpublishFailed") : t("toast.restoreFailed");
      console.error(fallback, response.error);
      toast.error(t("toast.actionFailedWith", { message: response.error?.message ?? fallback }));
    } finally {
      setWriting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      <PluginMarketCatalog
        packages={packages}
        loading={catalog.loading}
        error={catalog.error}
        query={query}
        scope={scope}
        canPublish={canPublish}
        selectedSlug={selected?.slug ?? null}
        detail={detail.data?.package ?? null}
        detailLoading={detail.loading}
        detailError={detail.error}
        writing={writing}
        onQueryChange={setQuery}
        onScopeChange={setScope}
        onSelect={setSelectedSlug}
        onPublish={() => setPublishOpen(true)}
        onUnpublish={(packageName, exactVersion) => setPending({ kind: "unpublish", packageName, exactVersion })}
        onRestore={(packageName, exactVersion) => setPending({ kind: "restore", packageName, exactVersion })}
        onRetry={catalog.refresh}
        onDetailRetry={detail.refresh}
      />

      <PluginMarketPublishDialog open={publishOpen} onOpenChange={setPublishOpen} onPublished={settleWrite} />

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
