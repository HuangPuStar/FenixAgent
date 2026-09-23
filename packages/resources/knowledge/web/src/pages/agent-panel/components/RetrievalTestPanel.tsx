"use client";

import "./RetrievalTestPanel.css";

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Button } from "@fenix/ui-components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@fenix/ui-components/ui/select";
import { Slider } from "@fenix/ui-components/ui/slider";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { Switch } from "@fenix/ui-components/ui/switch";
import { Textarea } from "@fenix/ui-components/ui/textarea";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { kbApi } from "../../../../api/knowledge-bases";
import { KnowledgeLoadFailure } from "../../../../pages/agent-panel/pages/agent-knowledge-load-failure";
import { FIELD_LABEL_CLASS } from "../../../../pages/agent-panel/pages/knowledge-typography";
import type { KnowledgeSearchResultData, MetaDataFilterMethod, RerankModelOption } from "../../../../types/knowledge";
import { RetrievalChunkCard } from "./retrieval-chunk-card";
import { buildRetrievalSearchPayload } from "./retrieval-search-payload";

/** 检索测试默认参数常量 */
const DEFAULTS = {
  similarityThreshold: 0.2,
  vectorSimilarityWeight: 0.3,
  pageSize: 10,
  keyword: false,
} as const;

/** 跨语言搜索支持的语言选项 */
const CROSS_LANGUAGE_OPTIONS = [
  { value: "English", label: "英语" },
  { value: "Chinese", label: "中文" },
  { value: "Spanish", label: "西班牙语" },
  { value: "French", label: "法语" },
  { value: "German", label: "德语" },
  { value: "Japanese", label: "日语" },
  { value: "Korean", label: "韩语" },
  { value: "Vietnamese", label: "越南语" },
  { value: "Arabic", label: "阿拉伯语" },
  { value: "Turkish", label: "土耳其语" },
] as const;

/** 所有语言值（用于"全部"选项的快捷选择） */
const ALL_LANGUAGE_VALUES = CROSS_LANGUAGE_OPTIONS.map((l) => l.value);

/** 元数据过滤 4 种模式 */
const META_FILTER_METHODS: {
  value: MetaDataFilterMethod;
  labelKey: "metaFilterDisabled" | "metaFilterAuto" | "metaFilterSemiAuto" | "metaFilterManual";
}[] = [
  { value: "disabled", labelKey: "metaFilterDisabled" },
  { value: "auto", labelKey: "metaFilterAuto" },
  { value: "semi_auto", labelKey: "metaFilterSemiAuto" },
  { value: "manual", labelKey: "metaFilterManual" },
];

interface RetrievalTestPanelProps {
  knowledgeBaseId: string;
}

/**
 * 知识库检索测试面板：左右两栏布局，左侧参数配置 + 右侧结果列表。
 * 支持相似度阈值、向量/全文权重、Rerank 模型、每页数、关键词匹配等核心参数。
 *
 * 本文件持有参数 state 与执行流程；请求体组装在 `retrieval-search-payload.ts`（纯函数），
 * 单条结果卡片在 `retrieval-chunk-card.tsx`（§4.7）。
 */
export function RetrievalTestPanel({ knowledgeBaseId }: RetrievalTestPanelProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);

  // 检索参数 state
  const [query, setQuery] = useState("");
  const [similarityThreshold, setSimilarityThreshold] = useState<number>(DEFAULTS.similarityThreshold);
  const [vectorSimilarityWeight, setVectorSimilarityWeight] = useState<number>(DEFAULTS.vectorSimilarityWeight);
  const [rerankId, setRerankId] = useState<string>("__none__");
  const [pageSize, setPageSize] = useState<number>(DEFAULTS.pageSize);
  const [keyword, setKeyword] = useState<boolean>(DEFAULTS.keyword);
  const [topK, setTopK] = useState(1024);
  const [useKg, setUseKg] = useState(false);
  const [crossLanguages, setCrossLanguages] = useState<string[]>([]);
  const [metaFilterMethod, setMetaFilterMethod] = useState<MetaDataFilterMethod>("disabled");
  const [metaFilterManualJson, setMetaFilterManualJson] = useState("");

  // 结果 & 加载 state
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<KnowledgeSearchResultData | null>(null);
  const [hasRun, setHasRun] = useState(false);
  // 检索失败原因。判据：`error && 无数据` 才让失败区接管结果区；`retrieval.noResults` 只表达
  // 「确实没有命中」，不得在失败时渲染（见下方结果区分支）。
  const [error, setError] = useState<unknown>(null);

  // rerank 模型列表（组件内拉取）
  const [rerankModels, setRerankModels] = useState<RerankModelOption[]>([]);

  // 组件挂载时拉取 rerank 模型列表（仅一次）
  useEffect(() => {
    let cancelled = false;
    kbApi
      .listRerankModels()
      .then((resp) => {
        if (!cancelled) setRerankModels(resp.data ?? []);
      })
      .catch(() => {
        // 模型列表拉取失败不阻断检索测试，下拉为空
        if (!cancelled) setRerankModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 执行检索测试
  const runSearch = useCallback(async () => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;

    setLoading(true);
    setHasRun(false);
    setResult(null);
    setError(null);

    try {
      // 请求体（含 meta_data_filter 的 disabled / 手动 JSON 语义）由纯函数组装，
      // 手动 JSON 非法时由它给出 `ok: false`，这里只负责提示与早退。
      const built = buildRetrievalSearchPayload({
        query: trimmedQuery,
        similarityThreshold,
        vectorSimilarityWeight,
        rerankId,
        keyword,
        pageSize,
        topK,
        useKg,
        crossLanguages,
        metaFilterMethod,
        metaFilterManualJson,
      });
      if (!built.ok) {
        toast.error(t("retrieval.metaFilterJsonError"));
        setLoading(false);
        return;
      }

      const resp = await kbApi.search({ id: knowledgeBaseId }, built.payload);
      // request() 不抛异常，需手动检查 success
      if (!resp.success || resp.data == null) {
        console.error("[RetrievalTestPanel] API returned error", resp.error);
        // 错误信封（普通对象，含 code）原样交给失败区：`isKnowledgeAccessDenied` 据此决定
        // 是否走无权限态（不给重试）。缺信封时构造同形的 `{ code, message }` 兜底（`message` 取字典
        // 文案而不是服务端原文）。
        setError(resp.error ?? { code: "UNKNOWN", message: t("retrieval.error") });
        // toast 只上屏稳定文案（§9.3）：信封里的 `message` 是服务端措辞，交给失败区与日志即可。
        toast.error(t("retrieval.error"));
        setHasRun(true);
        return;
      }
      setResult(resp.data);
      setHasRun(true);
    } catch (err) {
      console.error("[RetrievalTestPanel] search failed", err);
      setError(err);
      // 失败原因由下面的 `KnowledgeLoadFailure` 承担（该组件展示诊断说明），toast 只上屏稳定文案，
      // 不把 `err.message`（后端信封原文）重复铺一层（§9.3）。
      toast.error(t("retrieval.error"));
    } finally {
      setLoading(false);
    }
  }, [
    query,
    similarityThreshold,
    vectorSimilarityWeight,
    rerankId,
    keyword,
    pageSize,
    topK,
    useKg,
    crossLanguages,
    metaFilterMethod,
    metaFilterManualJson,
    knowledgeBaseId,
    t,
  ]);

  // 查询输入框回车提交
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        runSearch();
      }
    },
    [runSearch],
  );

  return (
    <div className="retrieval-test-layout grid grid-cols-1 gap-6">
      {/* ===== 左侧：检索参数面板 ===== */}
      <div className="retrieval-test-card rounded-2xl bg-white ring-1 ring-inset ring-slate-200/80 p-5 space-y-5">
        {/* 相似度阈值 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className={FIELD_LABEL_CLASS}>{t("retrieval.similarityThreshold")}</label>
            <span className="text-xs font-mono text-slate-500">{similarityThreshold.toFixed(2)}</span>
          </div>
          <Slider
            value={[similarityThreshold]}
            onValueChange={(vals: number[]) => setSimilarityThreshold(vals[0])}
            min={0}
            max={1}
            step={0.01}
          />
        </div>

        {/* 向量 / 全文权重 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className={FIELD_LABEL_CLASS}>{t("retrieval.vectorWeight")}</label>
            <span className="text-xs font-mono text-slate-500">
              {t("retrieval.vectorPercent", { pct: (vectorSimilarityWeight * 100).toFixed(0) })} /{" "}
              {t("retrieval.fullTextPercent", { pct: ((1 - vectorSimilarityWeight) * 100).toFixed(0) })}
            </span>
          </div>
          <Slider
            value={[vectorSimilarityWeight]}
            onValueChange={(vals: number[]) => setVectorSimilarityWeight(vals[0])}
            min={0}
            max={1}
            step={0.01}
          />
        </div>

        {/* Rerank 模型 */}
        <div className="space-y-1.5">
          <label className={FIELD_LABEL_CLASS}>{t("retrieval.rerankModel")}</label>
          <Select value={rerankId} onValueChange={setRerankId}>
            <SelectTrigger className="h-9 text-xs">
              <SelectValue placeholder={t("retrieval.noRerank")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t("retrieval.noRerank")}</SelectItem>
              {rerankModels.map((m) => (
                <SelectItem key={m.name} value={m.name}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Top K 候选数（仅选了 rerank 模型时可见） */}
        {rerankId !== "__none__" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className={FIELD_LABEL_CLASS}>{t("retrieval.topK")}</label>
              <span className="text-xs font-mono text-slate-500">{topK}</span>
            </div>
            <Slider value={[topK]} onValueChange={(vals: number[]) => setTopK(vals[0])} min={1} max={2048} step={1} />
          </div>
        )}

        {/* 每页返回数 */}
        <div className="space-y-1.5">
          <label className={FIELD_LABEL_CLASS}>{t("retrieval.pageSize")}</label>
          <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
            <SelectTrigger className="h-9 text-xs w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[10, 20, 30, 50].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* 关键词匹配开关 */}
        <div className="flex items-center justify-between">
          <label className={FIELD_LABEL_CLASS}>{t("retrieval.keywordMatch")}</label>
          <Switch checked={keyword} onCheckedChange={setKeyword} />
        </div>

        {/* 知识图谱检索 */}
        <div className="flex items-center justify-between">
          <label className={FIELD_LABEL_CLASS}>{t("retrieval.useKg")}</label>
          <Switch checked={useKg} onCheckedChange={setUseKg} />
        </div>

        {/* 跨语言搜索 */}
        <div className="space-y-1.5">
          <label className={FIELD_LABEL_CLASS}>{t("retrieval.crossLanguages")}</label>
          <div className="flex flex-wrap gap-1.5">
            {/* "全部"快捷按钮 */}
            <button
              type="button"
              onClick={() =>
                setCrossLanguages((prev) =>
                  prev.length === ALL_LANGUAGE_VALUES.length ? [] : [...ALL_LANGUAGE_VALUES],
                )
              }
              className={`inline-flex items-center rounded-md px-2.5 py-1 text-3xs font-medium border transition-all duration-150 ${
                crossLanguages.length === ALL_LANGUAGE_VALUES.length
                  ? "border-indigo-500 bg-indigo-500/10 text-indigo-500 shadow-sm"
                  : "border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:bg-slate-50"
              }`}
            >
              {t("retrieval.selectAll")}
            </button>
            {CROSS_LANGUAGE_OPTIONS.map((lang) => {
              const active = crossLanguages.includes(lang.value);
              return (
                <button
                  key={lang.value}
                  type="button"
                  onClick={() =>
                    setCrossLanguages((prev) => (active ? prev.filter((v) => v !== lang.value) : [...prev, lang.value]))
                  }
                  className={`inline-flex items-center rounded-md px-2.5 py-1 text-3xs font-medium border transition-all duration-150 ${
                    active
                      ? "border-indigo-500 bg-indigo-500/10 text-indigo-500 shadow-sm"
                      : "border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:bg-slate-50"
                  }`}
                >
                  {lang.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 元数据过滤 */}
        <div className="space-y-1.5">
          <label className={FIELD_LABEL_CLASS}>{t("retrieval.metaDataFilter")}</label>
          <Select value={metaFilterMethod} onValueChange={(v) => setMetaFilterMethod(v as MetaDataFilterMethod)}>
            <SelectTrigger className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {META_FILTER_METHODS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {t(`retrieval.${m.labelKey}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* 手动模式下显示 JSON 条件编辑器 */}
          {metaFilterMethod === "manual" && (
            <Textarea
              value={metaFilterManualJson}
              onChange={(e) => setMetaFilterManualJson(e.target.value)}
              placeholder={t("retrieval.metaFilterManualPlaceholder")}
              className="mt-2 min-h-15 resize-none text-xs font-mono"
            />
          )}
        </div>

        {/* 查询输入框 */}
        <div className="space-y-2">
          <Textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("retrieval.queryPlaceholder")}
            className="min-h-20 resize-none text-xs"
          />
          <Button
            className="w-full text-xs rounded-xl shadow-sm"
            size="default"
            onClick={runSearch}
            disabled={!query.trim() || loading}
          >
            {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
            {t("retrieval.runTest")}
          </Button>
        </div>
      </div>

      {/* ===== 右侧：检索结果列表 ===== */}
      <div className="retrieval-test-card rounded-2xl bg-white ring-1 ring-inset ring-slate-200/80 p-5">
        {!hasRun && !loading && (
          <EmptyState className="grid min-h-48 place-content-center" title={t("retrieval.enterQueryHint")} />
        )}

        {loading && (
          <div className="flex items-center justify-center min-h-50">
            <Spinner size="sm" />
          </div>
        )}

        {/* 检索失败：整区接管为可重试的持久错误态（重试重跑同一次检索）。 */}
        {!loading && error != null && (
          <KnowledgeLoadFailure error={error} title={t("retrieval.error")} onRetry={runSearch} />
        )}

        {error == null && hasRun && result && (
          <div className="space-y-4">
            {/* 结果统计 */}
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-900">
                {t("retrieval.resultCount", { count: result.total })}
              </p>
            </div>

            {/* 无结果 */}
            {result.chunks.length === 0 && (
              <EmptyState className="grid min-h-36 place-content-center" title={t("retrieval.noResults")} />
            )}

            {/* chunk 列表 */}
            <div className="retrieval-test-results space-y-3 overflow-y-auto pr-1">
              {result.chunks.map((chunk, idx) => (
                <RetrievalChunkCard key={chunk.chunkId || String(idx)} chunk={chunk} t={t} />
              ))}
            </div>
          </div>
        )}

        {/* 空态只表达「确实没有命中」：失败（error != null）由上面的失败区分支接管。 */}
        {error == null && hasRun && !result && (
          <EmptyState className="grid min-h-36 place-content-center" title={t("retrieval.noResults")} />
        )}
      </div>
    </div>
  );
}
