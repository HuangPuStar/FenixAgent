// web/src/pages/agent-panel/components/retrieval-search-payload.ts
// 检索测试的**请求体组装**（§4.7「传输适配」）：把面板上的参数收敛成 `kbApi.search` 的入参，
// 并承担两处协议语义——`disabled` 时不发 `meta_data_filter`、手动模式的 JSON 解析。
//
// 抽成纯函数的原因：面板里这段逻辑嵌在 `runSearch` 的 try 中，失败要改 `loading` / 早退，
// 让「参数 → 报文」成为可单独推理的一层；解析失败由调用方转成 toast + 早退，语义不变。

import type { MetaDataFilter, MetaDataFilterMethod } from "../../../../types/knowledge";

/** 检索面板上与请求体有关的参数（与 `RetrievalTestPanel` 的 state 一一对应） */
export interface RetrievalSearchInput {
  query: string;
  similarityThreshold: number;
  vectorSimilarityWeight: number;
  rerankId: string;
  keyword: boolean;
  pageSize: number;
  topK: number;
  useKg: boolean;
  crossLanguages: string[];
  metaFilterMethod: MetaDataFilterMethod;
  metaFilterManualJson: string;
}

/** 组装结果：手动过滤条件解析失败时返回 `invalid-json`，由调用方决定如何提示 */
export type RetrievalSearchPayloadResult =
  | { ok: true; payload: ReturnType<typeof buildRetrievalSearchInput> }
  | { ok: false };

function buildRetrievalSearchInput(input: RetrievalSearchInput, metaDataFilter: MetaDataFilter | undefined) {
  return {
    query: input.query.trim(),
    similarityThreshold: input.similarityThreshold,
    vectorSimilarityWeight: input.vectorSimilarityWeight,
    rerankId: input.rerankId === "__none__" ? null : input.rerankId,
    keyword: input.keyword,
    highlight: true, // 检索测试默认开启高亮
    pageSize: input.pageSize,
    topK: input.rerankId !== "__none__" ? input.topK : undefined,
    useKg: input.useKg,
    crossLanguages: input.crossLanguages.length > 0 ? input.crossLanguages : undefined,
    metaDataFilter,
  };
}

/**
 * 组装 `kbApi.search` 的请求体。
 *
 * - `disabled` 时不发送 `meta_data_filter`，避免 RAGFlow 端行为差异；
 * - 手动模式的 JSON 非法时返回 `{ ok: false }`（调用方提示 `retrieval.metaFilterJsonError` 并早退）；
 * - 数组按原语义整体赋给 `manual`，对象则合并进过滤条件。
 */
export function buildRetrievalSearchPayload(input: RetrievalSearchInput): RetrievalSearchPayloadResult {
  // disabled 时不发送 meta_data_filter，避免 RAGFlow 端行为差异
  let metaDataFilter: MetaDataFilter | undefined;
  if (input.metaFilterMethod !== "disabled") {
    metaDataFilter = { method: input.metaFilterMethod };
    if (input.metaFilterMethod === "manual" && input.metaFilterManualJson.trim()) {
      try {
        const parsed = JSON.parse(input.metaFilterManualJson);
        if (Array.isArray(parsed)) {
          metaDataFilter.manual = parsed;
        } else if (parsed && typeof parsed === "object") {
          Object.assign(metaDataFilter, parsed);
        }
      } catch {
        return { ok: false };
      }
    }
  }

  return { ok: true, payload: buildRetrievalSearchInput(input, metaDataFilter) };
}
