"use client";

import { Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { kbApi } from "@/src/api/knowledge-bases";
import { NS } from "@/src/i18n";
import type {
  KnowledgeRetrievalChunk,
  KnowledgeSearchResultData,
  MetaDataFilter,
  MetaDataFilterMethod,
  RerankModelOption,
} from "@/src/types/knowledge";

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
const META_FILTER_METHODS: { value: MetaDataFilterMethod; labelKey: string }[] = [
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

    try {
      // disabled 时不发送 meta_data_filter，避免 RAGFlow 端行为差异
      let metaDataFilter: MetaDataFilter | undefined;
      if (metaFilterMethod !== "disabled") {
        metaDataFilter = { method: metaFilterMethod };
        if (metaFilterMethod === "manual" && metaFilterManualJson.trim()) {
          try {
            const parsed = JSON.parse(metaFilterManualJson);
            if (Array.isArray(parsed)) {
              metaDataFilter.manual = parsed;
            } else if (parsed && typeof parsed === "object") {
              Object.assign(metaDataFilter, parsed);
            }
          } catch {
            toast.error(t("retrieval.metaFilterJsonError"));
            setLoading(false);
            return;
          }
        }
      }

      const resp = await kbApi.search(
        { id: knowledgeBaseId },
        {
          query: trimmedQuery,
          similarityThreshold,
          vectorSimilarityWeight,
          rerankId: rerankId === "__none__" ? null : rerankId,
          keyword,
          highlight: true, // 检索测试默认开启高亮
          pageSize,
          topK: rerankId !== "__none__" ? topK : undefined,
          useKg,
          crossLanguages: crossLanguages.length > 0 ? crossLanguages : undefined,
          metaDataFilter,
        },
      );
      // request() 不抛异常，需手动检查 success
      if (!resp.success || resp.data == null) {
        console.error("[RetrievalTestPanel] API returned error", resp.error);
        toast.error(resp.error?.message ?? t("retrieval.error"));
        setHasRun(true);
        return;
      }
      setResult(resp.data);
      setHasRun(true);
    } catch (err) {
      console.error("[RetrievalTestPanel] search failed", err);
      toast.error(err instanceof Error ? err.message : t("retrieval.error"));
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
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[340px_1fr]">
      {/* ===== 左侧：检索参数面板 ===== */}
      <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04),0_4px_12px_rgba(0,0,0,0.03)] ring-1 ring-inset ring-[#e8edf4]/80 p-5 space-y-5">
        {/* 相似度阈值 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-[13px] font-semibold text-[#0f172a]">{t("retrieval.similarityThreshold")}</label>
            <span className="text-[13px] font-mono text-[#64748b]">{similarityThreshold.toFixed(2)}</span>
          </div>
          <Slider
            value={[similarityThreshold]}
            onValueChange={(vals) => setSimilarityThreshold(vals[0])}
            min={0}
            max={1}
            step={0.01}
          />
        </div>

        {/* 向量 / 全文权重 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-[13px] font-semibold text-[#0f172a]">{t("retrieval.vectorWeight")}</label>
            <span className="text-[13px] font-mono text-[#64748b]">
              {t("retrieval.vectorPercent", { pct: (vectorSimilarityWeight * 100).toFixed(0) })} /{" "}
              {t("retrieval.fullTextPercent", { pct: ((1 - vectorSimilarityWeight) * 100).toFixed(0) })}
            </span>
          </div>
          <Slider
            value={[vectorSimilarityWeight]}
            onValueChange={(vals) => setVectorSimilarityWeight(vals[0])}
            min={0}
            max={1}
            step={0.01}
          />
        </div>

        {/* Rerank 模型 */}
        <div className="space-y-1.5">
          <label className="text-[13px] font-semibold text-[#0f172a]">{t("retrieval.rerankModel")}</label>
          <Select value={rerankId} onValueChange={setRerankId}>
            <SelectTrigger className="h-9 text-[13px]">
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
              <label className="text-[13px] font-semibold text-[#0f172a]">{t("retrieval.topK")}</label>
              <span className="text-[13px] font-mono text-[#64748b]">{topK}</span>
            </div>
            <Slider value={[topK]} onValueChange={(vals) => setTopK(vals[0])} min={1} max={2048} step={1} />
          </div>
        )}

        {/* 每页返回数 */}
        <div className="space-y-1.5">
          <label className="text-[13px] font-semibold text-[#0f172a]">{t("retrieval.pageSize")}</label>
          <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
            <SelectTrigger className="h-9 text-[13px] w-20">
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
          <label className="text-[13px] font-semibold text-[#0f172a]">{t("retrieval.keywordMatch")}</label>
          <Switch checked={keyword} onCheckedChange={setKeyword} />
        </div>

        {/* 知识图谱检索 */}
        <div className="flex items-center justify-between">
          <label className="text-[13px] font-semibold text-[#0f172a]">{t("retrieval.useKg")}</label>
          <Switch checked={useKg} onCheckedChange={setUseKg} />
        </div>

        {/* 跨语言搜索 */}
        <div className="space-y-1.5">
          <label className="text-[13px] font-semibold text-[#0f172a]">{t("retrieval.crossLanguages")}</label>
          <div className="flex flex-wrap gap-1.5">
            {/* "全部"快捷按钮 */}
            <button
              type="button"
              onClick={() =>
                setCrossLanguages((prev) =>
                  prev.length === ALL_LANGUAGE_VALUES.length ? [] : [...ALL_LANGUAGE_VALUES],
                )
              }
              className={`inline-flex items-center rounded-md px-2.5 py-1 text-[11px] font-medium border transition-all duration-150 ${
                crossLanguages.length === ALL_LANGUAGE_VALUES.length
                  ? "border-[#6366f1] bg-[#6366f1]/10 text-[#6366f1] shadow-sm"
                  : "border-[#e2e8f0] bg-white text-[#64748b] hover:border-[#c0c8d4] hover:bg-[#f8fafc]"
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
                  className={`inline-flex items-center rounded-md px-2.5 py-1 text-[11px] font-medium border transition-all duration-150 ${
                    active
                      ? "border-[#6366f1] bg-[#6366f1]/10 text-[#6366f1] shadow-sm"
                      : "border-[#e2e8f0] bg-white text-[#64748b] hover:border-[#c0c8d4] hover:bg-[#f8fafc]"
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
          <label className="text-[13px] font-semibold text-[#0f172a]">{t("retrieval.metaDataFilter")}</label>
          <Select value={metaFilterMethod} onValueChange={(v) => setMetaFilterMethod(v as MetaDataFilterMethod)}>
            <SelectTrigger className="h-9 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {META_FILTER_METHODS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {/* biome-ignore lint/suspicious/noExplicitAny: i18n key interpolation */}
                  {t(`retrieval.${m.labelKey}` as any)}
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
              className="mt-2 min-h-[60px] resize-none text-[12px] font-mono"
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
            className="min-h-[80px] resize-none text-[13px]"
          />
          <Button
            className="w-full text-[13px] rounded-xl shadow-sm"
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
      <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04),0_4px_12px_rgba(0,0,0,0.03)] ring-1 ring-inset ring-[#e8edf4]/80 p-5">
        {!hasRun && !loading && (
          <div className="flex items-center justify-center min-h-[200px]">
            <p className="text-[13px] text-[#94a3b8]">{t("retrieval.enterQueryHint")}</p>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center min-h-[200px]">
            <Loader2 className="h-6 w-6 text-[#1677ff] animate-spin" />
          </div>
        )}

        {hasRun && result && (
          <div className="space-y-4">
            {/* 结果统计 */}
            <div className="flex items-center justify-between">
              <p className="text-[14px] font-semibold text-[#0f172a]">
                {t("retrieval.resultCount", { count: result.total })}
              </p>
            </div>

            {/* 无结果 */}
            {(result.chunks?.length ?? 0) === 0 && (
              <div className="flex items-center justify-center min-h-[150px]">
                <p className="text-[13px] text-[#94a3b8]">{t("retrieval.noResults")}</p>
              </div>
            )}

            {/* chunk 列表 */}
            <div className="space-y-3 max-h-[calc(100vh-340px)] overflow-y-auto pr-1">
              {(result.chunks ?? []).map((chunk, idx) => (
                <RetrievalChunkCard key={chunk.chunkId || String(idx)} chunk={chunk} t={t} />
              ))}
            </div>
          </div>
        )}

        {hasRun && !result && (
          <div className="flex items-center justify-center min-h-[150px]">
            <p className="text-[13px] text-[#94a3b8]">{t("retrieval.noResults")}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// 辅助组件 & 函数
// ============================================================

/** 格式化相似度为百分比字符串（保留 2 位小数） */
function fmtScore(s: number | null | undefined): string {
  if (s == null) return "—";
  return `${(s * 100).toFixed(2)}%`;
}

/**
 * RAGFlow 高亮内容渲染组件。
 * 使用 dangerouslySetInnerHTML 渲染后端返回的含 <em> 标签的高亮 HTML，来源受控。
 */
function HighlightSpan({ html, className }: { html: string; className: string }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: RAGFlow 后端返回的高亮 HTML，来源受控
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ============================================================
// 子组件：检索结果单条卡片
// ============================================================

interface ChunkCardProps {
  chunk: KnowledgeRetrievalChunk;
  t: ReturnType<typeof useTranslation<"knowledge">>["t"];
}

function RetrievalChunkCard({ chunk, t }: ChunkCardProps) {
  return (
    <div className="rounded-xl border border-[#e8edf4] bg-white p-4 space-y-3 shadow-sm hover:shadow-md transition-shadow">
      {/* 文档名 + 三种相似度 */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[12px] font-semibold text-[#0f172a] truncate max-w-[55%]">{chunk.documentName}</span>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="inline-flex items-center gap-1 rounded-md bg-gradient-to-r from-[#6366f1]/10 to-[#8b5cf6]/10 px-2 py-0.5 text-[11px] font-semibold text-[#6366f1] border border-[#6366f1]/15">
            {t("retrieval.hybridSimilarity")}: {fmtScore(chunk.similarity)}
          </span>
          {chunk.vectorSimilarity != null && (
            <span className="inline-flex items-center gap-1 rounded-md bg-[#10b981]/10 px-2 py-0.5 text-[11px] font-semibold text-[#10b981] border border-[#10b981]/15">
              {t("retrieval.vectorSimilarity")}: {fmtScore(chunk.vectorSimilarity)}
            </span>
          )}
          {chunk.termSimilarity != null && (
            <span className="inline-flex items-center gap-1 rounded-md bg-[#f59e0b]/10 px-2 py-0.5 text-[11px] font-semibold text-[#f59e0b] border border-[#f59e0b]/15">
              {t("retrieval.termSimilarity")}: {fmtScore(chunk.termSimilarity)}
            </span>
          )}
        </div>
      </div>

      {/* chunk 内容（有高亮则渲染 HTML，无则纯文本） */}
      <div className="text-[13px] text-[#334155] leading-relaxed whitespace-pre-wrap break-words">
        {chunk.highlight ? (
          <HighlightSpan
            html={chunk.highlight}
            className="[&_em]:not-italic [&_em]:bg-yellow-200 [&_em]:text-[#0f172a] [&_em]:rounded [&_em]:px-0.5"
          />
        ) : (
          chunk.content
        )}
      </div>

      {/* 关键词标签 */}
      {chunk.importantKeywords && chunk.importantKeywords.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {chunk.importantKeywords.map((kw) => (
            <span
              key={kw}
              className="inline-block rounded-md bg-[#f1f5f9] border border-[#e2e8f0] px-2 py-0.5 text-[11px] font-medium text-[#64748b]"
            >
              {kw}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
