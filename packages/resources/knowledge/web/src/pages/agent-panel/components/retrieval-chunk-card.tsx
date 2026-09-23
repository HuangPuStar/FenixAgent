// web/src/pages/agent-panel/components/retrieval-chunk-card.tsx
// 检索结果单条卡片的渲染（§4.7 拆出的叶子渲染模块）：文档名 + 三种相似度 + 高亮正文 + 关键词标签。
//
// 从 `RetrievalTestPanel.tsx` 拆出：卡片与面板的状态、取数、参数表单无关，只吃一个 chunk。
// 高亮正文仍走 `sanitizeHighlightHtml` 的最小白名单（`lib/sanitize-html.ts`，宿主文件清单见
// `web/__tests__/sanitize-html.test.ts` 的 CALL_SITES）。

import type { useTranslation } from "react-i18next";
import { sanitizeHighlightHtml } from "../../../../lib/sanitize-html";
import type { KnowledgeRetrievalChunk } from "../../../../types/knowledge";

/** 格式化相似度为百分比字符串（保留 2 位小数） */
function fmtScore(s: number | null | undefined): string {
  if (s == null) return "—";
  return `${(s * 100).toFixed(2)}%`;
}

/**
 * RAGFlow 高亮内容渲染组件。
 *
 * 后端返回的是带 `<em>` 高亮标记的 HTML（契约见 `src/server/schemas/knowledge.schema.ts` 的
 * `highlight` 字段），必须清洗后再注入：检索结果包含知识库原文，不能视为受控内容。
 * 清洗用 `sanitizeHighlightHtml` 的**最小白名单**（只留 `<em>` / `<span>` / `<br>` 与 class），
 * 见 `web/lib/sanitize-html.ts`；`<em>` 的高亮样式按调用方传入的类名
 * （`.retrieval-test-highlight`，见同目录 RetrievalTestPanel.css）落在 CSS 里。
 */
function HighlightSpan({ html, className }: { html: string; className: string }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: 同一行的 sanitizeHighlightHtml 已清洗（只留 <em>/<span> 高亮标签）
  return <span className={className} dangerouslySetInnerHTML={{ __html: sanitizeHighlightHtml(html) }} />;
}

interface ChunkCardProps {
  chunk: KnowledgeRetrievalChunk;
  t: ReturnType<typeof useTranslation<"knowledge">>["t"];
}

export function RetrievalChunkCard({ chunk, t }: ChunkCardProps) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3 shadow-sm hover:shadow-md transition-shadow">
      {/* 文档名 + 三种相似度 */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs font-semibold text-slate-900 truncate max-w-[55%]">{chunk.documentName}</span>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="inline-flex items-center gap-1 rounded-md bg-gradient-to-r from-indigo-500/10 to-violet-500/10 px-2 py-0.5 text-3xs font-semibold text-indigo-500 border border-indigo-500/15">
            {t("retrieval.hybridSimilarity")}: {fmtScore(chunk.similarity)}
          </span>
          {chunk.vectorSimilarity != null && (
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-3xs font-semibold text-emerald-500 border border-emerald-500/15">
              {t("retrieval.vectorSimilarity")}: {fmtScore(chunk.vectorSimilarity)}
            </span>
          )}
          {chunk.termSimilarity != null && (
            <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-3xs font-semibold text-amber-500 border border-amber-500/15">
              {t("retrieval.termSimilarity")}: {fmtScore(chunk.termSimilarity)}
            </span>
          )}
        </div>
      </div>

      {/* chunk 内容（有高亮则渲染 HTML，无则纯文本） */}
      <div className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap break-words">
        {chunk.highlight ? (
          <HighlightSpan html={chunk.highlight} className="retrieval-test-highlight" />
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
              className="inline-block rounded-md bg-slate-100 border border-slate-200 px-2 py-0.5 text-3xs font-medium text-slate-500"
            >
              {kw}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
