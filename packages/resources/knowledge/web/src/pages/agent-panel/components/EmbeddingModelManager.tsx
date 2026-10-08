/**
 * EmbeddingModelManager — 模型供应商管理组件（三级树）
 *
 * RAGFlow v0.26 的模型管理结构是三级：供应商(provider) → 实例(instance，即一组
 * API Key) → 模型(model)。本组件按此结构展示与管理：
 *
 * - 列表：provider 折叠 > instance 折叠 > model（每个 model 有 active/inactive 开关）
 * - 屏蔽模型：切换 model 为 inactive，新建 KB 时该 embedding 模型被 RAGFlow 拒绝
 *   （LookupError: Model ... is disabled），实现「新建时不可见」；老 KB 不受影响。
 *   屏蔽的模型在管理页仍可见（灰色），可随时取消屏蔽。
 * - 删除实例：删除一组 API Key（instance）及其下所有模型配置。删除粒度是实例，
 *   不是单个模型、也不是整个供应商。
 * - 添加：必填实例名（默认 = 厂商名），提交后该厂商目录下所有模型自动可用。
 *
 * 归属：本组件自 `@fenix/model-management/web` 移入本包。它管理的是 RAGFlow 的 embedding 模型
 * （数据面就是本包路由 `POST /web/knowledgeBases/models`），唯一消费方也是本包页面
 * `AgentKnowledgeBasesPage`；放在 model-management 会让两个包互引、barrel 在值导入图上成环
 * （收敛理由见 `packages/resources/model-management/README.md`）。它不依赖 model-management 的
 * 任何内部模块，因此这次移动只是包归属变更，未改行为。
 *
 * 结构（§4.7）：本文件是管理器壳——取数、刷新键、删除确认与三态；列表行在
 * `embedding-model-rows.tsx`，添加供应商弹窗在 `add-embedding-provider-dialog.tsx`。
 */

import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { unwrap } from "@fenix/web-runtime/api/request";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useRequest } from "ahooks";
import { Cpu, Plus, RefreshCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { embeddingModelApi } from "../../../../api/knowledge-models";
import type { ConfiguredInstanceNode } from "../../../../types/knowledge";
import { AddProviderDialog } from "./add-embedding-provider-dialog";
import { ProviderRow } from "./embedding-model-rows";

interface EmbeddingModelManagerProps {
  /** 是否有管理权限（用于显示/隐藏添加、删除、屏蔽按钮） */
  canManage: boolean;
  /** 是否在 Dialog 内渲染（隐藏标题副文案，避免与 Dialog 重复） */
  inDialog?: boolean;
  /**
   * 模型集合发生变更（增删供应商、切换模型 active/inactive）后的回调。
   * 父层可用它刷新「创建知识库」表单的嵌入模型可选项，避免新建时仍展示
   * 已屏蔽的模型或缺失新增的模型。
   */
  onModelsChanged?: () => void;
}

export function EmbeddingModelManager({ canManage, inDialog, onModelsChanged }: EmbeddingModelManagerProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  const [refreshKey, setRefreshKey] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  // 「添加供应商」弹窗的表单重置靠 `key`（§4.2 / §4.3）：计数只在**打开**时自增，弹窗整体重挂载、
  // 字段从默认值起算。原先弹窗自己在关闭时 `setTimeout(reset, 200)` 绕开退出动画，那条计时器已删除。
  const [addDialogKey, setAddDialogKey] = useState(0);
  const openAddDialog = () => {
    setAddDialogKey((key) => key + 1);
    setAddOpen(true);
  };
  // 待确认删除的实例：原生 confirm 的同步返回值无法保留，改为挂起目标实例 + 受控 ConfirmDialog。
  const [deleteTarget, setDeleteTarget] = useState<ConfiguredInstanceNode | null>(null);

  const {
    data: tree,
    loading,
    error: listError,
    refresh,
  } = useRequest(() => unwrap(embeddingModelApi.list()), {
    refreshDeps: [refreshKey],
    onError: (err) => {
      // 此前只上屏、不落日志：原始对象先进诊断通道。文案只取字典（§9.3），
      // `err.message` 是 `unwrap` 抛出的 `ApiError.message`（后端信封原文）。
      console.error("Failed to load embedding model tree", err);
      toast.error(t("embeddingModel.listLoadFailed"));
    },
  });

  const treeSafe = tree ?? [];
  const providerCount = treeSafe.length;
  const instanceCount = treeSafe.reduce((sum, p) => sum + (p.instances?.length ?? 0), 0);

  // 真正的删除：只在 ConfirmDialog 确认后调用（原先由本函数内联的 confirm 决定是否继续）。
  const runDeleteInstance = async (inst: ConfiguredInstanceNode) => {
    try {
      await unwrap(embeddingModelApi.delete({ provider: inst.provider, instanceName: inst.instanceName }));
      toast.success(t("embeddingModel.instanceDeleted"));
      setRefreshKey((k) => k + 1);
      onModelsChanged?.();
    } catch (err) {
      console.error("Failed to delete embedding instance", err);
      toast.error(t("embeddingModel.deleteFailed"));
    }
  };

  // 管理器与弹窗内工具栏的间距 14px / 36px / 16px = `gap-3.5` / `min-h-9` / `gap-4`：
  // 刻度已在 `@theme` 按 px 落地，工具类即设计值。工具栏文案 / 图标、树的描边与子层的
  // `border-color` 也都在 `className` 上（2026-09-28），`AgentKnowledgeBasesPage.css` 里与本组件相关的
  // 只剩一条挂不上类名的按钮 hover（树内两级行组件与 Radix Switch 的 `<button>` 拿不到 `inDialog`）。
  return (
    <div
      className={
        inDialog
          ? "embedding-model-manager embedding-model-manager--dialog flex flex-col gap-3.5"
          : "embedding-model-manager flex flex-col gap-3.5"
      }
    >
      {/* 顶部工具栏（弹窗内渲染时不显示，标题由 Dialog 提供） */}
      {!inDialog && (
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              {providerCount > 0
                ? t("embeddingModel.titleWithCount", { providers: providerCount, instances: instanceCount })
                : t("embeddingModel.title")}
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">{t("embeddingModel.subtitle")}</p>
          </div>
          {canManage && (
            <Button
              size="sm"
              onClick={openAddDialog}
              className="h-8 gap-1.5 text-xs rounded-lg bg-indigo-500 hover:bg-indigo-500"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("embeddingModel.addProvider")}
            </Button>
          )}
        </div>
      )}
      {inDialog && (
        <div className="embedding-model-toolbar flex min-h-9 items-center justify-between gap-4">
          {/* 说明文案的字号 / 颜色 2026-09-28 自 `.embedding-model-toolbar p` 的后代规则搬回
              （`text-xs` = 原 12px、`text-slate-400` = 原 `#8492a8`），添加按钮里的图标同批自
              `.embedding-model-toolbar svg` 搬回（`size-3.75` = 原 15px；带上 `size-` 类名后
              `Button` 的 `[&_svg:not([class*='size-'])]:size-4` 不再命中，与原来被覆盖的结果一致）。 */}
          <p className="text-xs text-slate-400">
            {providerCount > 0
              ? t("embeddingModel.providerInstanceSummary", { providers: providerCount, instances: instanceCount })
              : t("embeddingModel.noProviderConfigured")}
          </p>
          {canManage ? (
            <Button size="sm" onClick={openAddDialog}>
              <Plus className="size-3.75" />
              {t("embeddingModel.addProvider")}
            </Button>
          ) : null}
        </div>
      )}

      {/* 三级树 */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      ) : listError ? (
        // 失败必须与「确实还没配置供应商」分开：`tree` 在失败时停在 `undefined`，`providerCount` 也是 0，
        // 照旧渲染只会得到「暂无已配置的模型供应商」——与空态同形（§3.4）。重试走 `refresh`（重新拉取）。
        <EmptyState
          className="py-16"
          icon={<TriangleAlert />}
          title={t("embeddingModel.listLoadFailed")}
          tone="danger"
          role="alert"
          action={{ label: t("embeddingModel.retry"), onClick: refresh, icon: <RefreshCw />, disabled: loading }}
        />
      ) : providerCount === 0 ? (
        <EmptyState
          className="py-16"
          icon={<Cpu />}
          title={t("embeddingModel.emptyTitle")}
          description={t("embeddingModel.emptyDescription")}
        />
      ) : (
        // 树容器的描边 / 圆角 2026-09-28 自 `.embedding-model-tree` 搬回（原 `1px #e1e7f0` + 10px →
        // `border border-slate-200 rounded-lg`）。子层那条 `--dialog` 下的 `border-color` 也搬到这里：
        // 它原样落在本元素上（本元素无边框宽度，画分隔线的是子元素自己的 `border-t border-slate-100`，
        // 故这条声明是「有值但不可见」的，搬迁只为消掉「修饰类 + 子代选择器」）。
        <div className="embedding-model-tree overflow-hidden bg-white border border-slate-200 rounded-lg">
          <div className={inDialog ? "divide-y divide-slate-100 border-slate-100" : "divide-y divide-slate-100"}>
            {treeSafe.map((p) => (
              <ProviderRow
                key={p.provider}
                provider={p}
                canManage={canManage}
                onDeleteInstance={(inst) => setDeleteTarget(inst)}
                onModelsChanged={onModelsChanged}
              />
            ))}
          </div>
        </div>
      )}

      <AddProviderDialog
        key={addDialogKey}
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => {
          setRefreshKey((k) => k + 1);
          onModelsChanged?.();
        }}
      />

      {/* 删除实例二次确认：文案沿用删除按钮的 tooltip 作标题、原 confirm 文案作描述（含实例名/供应商/模型数插值）。 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("embeddingModel.deleteInstanceTitle")}
        description={t("embeddingModel.deleteConfirm", {
          instance: deleteTarget?.instanceName ?? "",
          provider: deleteTarget?.provider ?? "",
          count: deleteTarget?.models?.length ?? 0,
        })}
        variant="destructive"
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target) runDeleteInstance(target);
        }}
      />
    </div>
  );
}
