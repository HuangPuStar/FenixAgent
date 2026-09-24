// web/pages/agent-panel/pages/knowledge-base-detail-view.tsx
// 知识库详情视图（§4.7 拆出的叶子渲染模块）：右侧详情区的四态占位 + 详情头部（标题 / 状态 / 配置项 /
// 编辑删除入口）+ 三个 Tab（文档 / 图谱 / 检索测试）。
//
// 从 `AgentKnowledgeBasesPage.tsx` 拆出：它不持有任何状态，只按 props 渲染；详情与资源域的状态在
// `use-knowledge-base-detail`，列表域的表单元数据（分块方法的中文名要查选项）由调用方作为 props 递进来。
//
// 三态判据与拆分前一致：`!kbId`（未选中）→ 选择提示；`loading` → 骨架；`error` → 可重试失败区；
// 三者与下面的详情面板互不互斥（重取同一知识库时两者会同时在场，见 `detailLoading` 的 Spinner）。

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@fenix/ui-components/ui/tabs";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { BookOpen, Braces, Cpu, File, Globe, Layers, Scissors } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { RetrievalTestPanel } from "../../../src/pages/agent-panel/components/RetrievalTestPanel";
import type {
  KnowledgeBaseDetail,
  KnowledgeFormOptions,
  KnowledgeParseMethod,
  KnowledgeResourceInfo,
} from "../../../types/knowledge";
import { KnowledgeGraphPanel } from "../KnowledgeGraphPanel";
import { KnowledgeLoadFailure } from "./agent-knowledge-load-failure";
import { AgentKnowledgeResources } from "./agent-knowledge-resources";
import { KB_STATUS_TONES, kbStatusLabel } from "./knowledge-status";
import type { KnowledgeDetailTab } from "./use-knowledge-base-detail";

interface KnowledgeBaseDetailViewProps {
  /** 当前选中的知识库 id（未选中时渲染选择提示） */
  kbId: string | null;
  /** 详情数据；null 表示还没取到（未选中 / 首次加载中 / 加载失败） */
  detail: KnowledgeBaseDetail | null;
  resources: KnowledgeResourceInfo[];
  loading: boolean;
  /** 详情加载失败的字符串消息（`KnowledgeLoadFailure` 接字符串形态） */
  error: string | null;
  tab: KnowledgeDetailTab;
  /** 表单元数据：详情里的「分块方法」要按值查它的可读名 */
  options: KnowledgeFormOptions | null;
  canManage: boolean;
  uploading: boolean;
  deletingResourceId: string | null;
  reparsingResourceId: string | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onTabChange: (tab: KnowledgeDetailTab) => void;
  onRetry: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onFilesSelected: (files: File[]) => void;
  onOpenChunks: (resource: KnowledgeResourceInfo) => void;
  onToggleEnabled: (resource: KnowledgeResourceInfo, enabled: boolean) => void;
  onReparse: (resource: KnowledgeResourceInfo) => void;
  onPreview: (resource: KnowledgeResourceInfo) => void;
  onDeleteResource: (resource: KnowledgeResourceInfo) => void;
}

export function KnowledgeBaseDetailView(props: KnowledgeBaseDetailViewProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  const { kbId, detail, options } = props;

  // 解析方法可读文案（详情只读展示用）
  const parseMethodLabel = (pm: KnowledgeParseMethod | null) => {
    if (pm === "builtin") return t("detailConfig.parseMethodBuiltin");
    if (pm === "pipeline") return t("detailConfig.parseMethodPipeline");
    return t("detailConfig.notSet");
  };

  const chunkMethodLabel = (value: string | null) => {
    if (!value) return t("detailConfig.notSet");
    const matched = options?.chunkMethods.find((c) => c.value === value);
    if (matched?.label) return matched.label;
    if (matched?.labelKey) return t(matched.labelKey);
    return value;
  };

  return (
    <>
      {!kbId ? (
        <EmptyState className="grid min-h-full place-content-center p-8" icon={<BookOpen />} title={t("selectHint")} />
      ) : props.loading ? (
        <div className="space-y-4 p-7" aria-busy="true">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : props.error ? (
        <KnowledgeLoadFailure
          error={props.error}
          title={t("loadDetailError")}
          onRetry={props.onRetry}
          className="grid min-h-full place-content-center p-8"
        />
      ) : null}

      {/* ===== 详情视图 ===== */}
      {detail && (
        <div className="flex flex-col flex-1 min-h-0">
          {/* 加载中 */}
          {props.loading && <Spinner size="lg" label={t("detail.loading")} className="flex h-64" />}

          {!props.loading && (
            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
              <div className="knowledge-detail">
                <section className="knowledge-detail-header">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h2 className="truncate text-xl font-semibold text-slate-800">{detail.name}</h2>
                        {/* 圆点与文案此前拆在两处：一个只给圆点上色的 `getStatusDot`，一个手写
                            `bg-emerald-50 ring-emerald-200` 的 `getStatusBadge`（第三份状态色表）。
                            色表收敛到 `knowledge-status.ts` 后由 StatusBadge 一并承担，圆点回到
                            它真正属于的位置——状态的胶囊内部。 */}
                        <StatusBadge
                          status={detail.status}
                          label={kbStatusLabel(t, detail.status)}
                          toneMap={KB_STATUS_TONES}
                          indicator="dot"
                        />
                      </div>
                      <p className="mt-1 font-mono text-3xs text-slate-400">{detail.slug}</p>
                      {detail.description && (
                        <p className="mt-2 max-w-3xl text-xs leading-5 text-slate-500">{detail.description}</p>
                      )}
                      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                        <span className="inline-flex items-center gap-1.5">
                          <File className="size-3.5" />
                          {t("card.resourcesUnit", { count: detail.resourcesCount })}
                        </span>
                        {detail.bindingsCount > 0 && (
                          <span className="inline-flex items-center gap-1.5">
                            <Braces className="size-3.5" />
                            {t("detail.boundAgents", { count: detail.bindingsCount })}
                          </span>
                        )}
                        {detail.remoteId && (
                          <span className="inline-flex min-w-0 items-center gap-1.5 text-slate-400">
                            <Globe className="size-3.5 shrink-0" />
                            <span className="truncate">Remote ID: {detail.remoteId}</span>
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button size="sm" variant="outline" disabled={!props.canManage} onClick={props.onEdit}>
                        {t("btn.edit")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-500 hover:bg-red-50 hover:text-red-600"
                        disabled={!props.canManage}
                        onClick={props.onDelete}
                      >
                        {t("btn.delete")}
                      </Button>
                    </div>
                  </div>
                  <div className="knowledge-detail-summary">
                    <ConfigItem
                      icon={<Cpu className="size-4 text-blue-500" />}
                      label={t("detailConfig.embeddingModel")}
                    >
                      {detail.embeddingModel ?? t("detailConfig.notSet")}
                    </ConfigItem>
                    <ConfigItem
                      icon={<Layers className="size-4 text-indigo-500" />}
                      label={t("detailConfig.parseMethod")}
                    >
                      {parseMethodLabel(detail.parseMethod)}
                    </ConfigItem>
                    <ConfigItem
                      icon={<Scissors className="size-4 text-teal-600" />}
                      label={t("detailConfig.chunkMethod")}
                    >
                      {chunkMethodLabel(detail.chunkMethod)}
                    </ConfigItem>
                  </div>
                </section>

                {/* Tab 切换：文档 | 检索测试 */}
                <Tabs
                  value={props.tab}
                  onValueChange={(v) => props.onTabChange(v as KnowledgeDetailTab)}
                  className="knowledge-tabs"
                >
                  <TabsList>
                    <TabsTrigger value="documents">{t("tabs.documents")}</TabsTrigger>
                    <TabsTrigger value="graph">{t("tabs.graph")}</TabsTrigger>
                    <TabsTrigger value="retrieval">{t("tabs.retrievalTest")}</TabsTrigger>
                  </TabsList>

                  <TabsContent value="documents" className="flex flex-col flex-1 min-h-0 space-y-6">
                    <AgentKnowledgeResources
                      resources={props.resources}
                      canManage={props.canManage}
                      uploading={props.uploading}
                      deletingResourceId={props.deletingResourceId}
                      reparsingResourceId={props.reparsingResourceId}
                      fileInputRef={props.fileInputRef}
                      onFilesSelected={props.onFilesSelected}
                      onOpenChunks={props.onOpenChunks}
                      onToggleEnabled={props.onToggleEnabled}
                      onReparse={props.onReparse}
                      onPreview={props.onPreview}
                      onDelete={props.onDeleteResource}
                    />
                  </TabsContent>

                  <TabsContent value="graph" forceMount className="data-[state=inactive]:hidden">
                    {props.tab === "graph" && (
                      <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-inset ring-slate-200/80">
                        <KnowledgeGraphPanel knowledgeBaseId={detail.id} canManage={props.canManage} />
                      </div>
                    )}
                  </TabsContent>

                  {/* 检索测试 Tab — 仅在切换到此 tab 时挂载 */}
                  <TabsContent value="retrieval" forceMount className="data-[state=inactive]:hidden">
                    {props.tab === "retrieval" && <RetrievalTestPanel knowledgeBaseId={detail.id} />}
                  </TabsContent>
                </Tabs>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** 详情头部配置项：图标 + 标签 + 值 */
function ConfigItem({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg bg-slate-50 px-3 py-2.5">
      <div className="grid size-8 shrink-0 place-items-center rounded-md border border-slate-200 bg-white">{icon}</div>
      <div className="min-w-0">
        <div className="text-3xs font-medium uppercase tracking-wider text-slate-400">{label}</div>
        <div className="mt-0.5 truncate text-xs font-medium text-gray-700" title={String(children)}>
          {children}
        </div>
      </div>
    </div>
  );
}
