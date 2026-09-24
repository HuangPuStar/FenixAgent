// web/components/knowledge/use-resource-preview.ts
// 资源预览的**取数编排**（§3.5 三层拆分的第二层）：文本 / Markdown / HTML 正文的前端取数，
// 以及 Office 文档「先探测服务端 PDF 转换、不可用时用 mammoth 转 docx」的两步探测。
//
// 从 `ResourcePreviewContent.tsx` 拆出（§4.7）：正文 / 转换模式这些状态此前与按类型分发的渲染
// 挤在同一个组件里，渲染分支既读状态又发请求。拆开后渲染只读状态，请求与「换资源即重置」都归本 hook
// （`resource.id` 是刻意的重触发信号，见下面 effect 上的注释）。

import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useRequest } from "ahooks";
import mammoth from "mammoth";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  fetchResourceFileBinary,
  fetchResourceFileText,
  isResourcePdfPreviewAvailable,
} from "../../api/knowledge-bases";
import { type FileCategory, getOfficeKind } from "./resource-preview-model";

/** Office 预览模式：checking → loading → pdf 可用 → mammoth(仅 docx) → download 降级 */
type OfficeMode = "checking" | "pdf" | "docxHtml" | "fallback";

interface UseResourcePreviewOptions {
  kbId: string;
  resourceId: string;
  /** 资源名：判 Office 子类型（Word 才走 mammoth）与取扩展名 */
  sourceName: string;
  /** 由 `getFileCategory` 得出的预览类别，决定要不要取正文 / 探测 Office */
  category: FileCategory;
}

export function useResourcePreview({ kbId, resourceId, sourceName, category }: UseResourcePreviewOptions) {
  const { t } = useTranslation(NS.KNOWLEDGE);

  // —— 文本 / Markdown 内容加载 ——
  const needsFetch = category === "markdown" || category === "text" || category === "html";
  const [fetchedContent, setFetchedContent] = useState<string | null>(null);

  const {
    loading: fetchLoading,
    error: fetchError,
    run: runFetch,
  } = useRequest(() => fetchResourceFileText({ kbId, resourceId }), {
    manual: true,
    onSuccess: setFetchedContent,
    onError: (err) => {
      console.error("Failed to fetch preview content", err);
      toast.error(t("preview.loadError"));
    },
  });

  // —— Office 文档预览：先尝试 PDF 转换，不可用时用 mammoth(docx) 或降级 ——
  const isOffice = category === "office";
  const officeKind = isOffice ? getOfficeKind(sourceName) : "word";
  const [officeMode, setOfficeMode] = useState<OfficeMode>("checking");
  const [docxHtml, setDocxHtml] = useState<string | null>(null);

  // 检查 PDF 转换端点是否可用
  const { loading: officeLoading, run: runOfficeCheck } = useRequest(
    async (): Promise<OfficeMode> => {
      if (await isResourcePdfPreviewAvailable({ kbId, resourceId })) {
        return "pdf";
      }
      // PDF 不可用，对 Word 文档尝试 mammoth 客户端转换
      if (officeKind === "word") {
        try {
          const arrayBuffer = await fetchResourceFileBinary({ kbId, resourceId });
          const result = await mammoth.convertToHtml({ arrayBuffer });
          setDocxHtml(result.value);
          return "docxHtml";
        } catch (mammothErr) {
          console.error("mammoth conversion failed", mammothErr);
        }
      }
      return "fallback";
    },
    {
      manual: true,
      onSuccess: (mode) => setOfficeMode(mode),
      onError: () => setOfficeMode("fallback"),
    },
  );

  const needsOfficeCheck = isOffice;

  const startOfficeCheck = useCallback(() => {
    setOfficeMode("checking");
    setDocxHtml(null);
    runOfficeCheck();
  }, [runOfficeCheck]);

  // 资源变化时触发加载。
  // `resourceId` 是刻意的重触发信号，而不是被 effect body 读取的值：同类型的两个资源互换时
  // `needsFetch` / `needsOfficeCheck` 都不变，只有资源身份能表达「换了资源」，删掉它预览会停在上一个资源。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 规则是语法分析，看不到「依赖变化即重新拉取」的意图（同批 agent-config 的 SiteFrame reloadKey 同款）
  useEffect(() => {
    setFetchedContent(null);
    setOfficeMode("checking");
    setDocxHtml(null);
    if (needsFetch) {
      runFetch();
    }
    if (needsOfficeCheck) {
      startOfficeCheck();
    }
  }, [needsFetch, needsOfficeCheck, resourceId, runFetch, startOfficeCheck]);

  return { fetchedContent, fetchLoading, fetchError, officeMode, officeLoading, docxHtml };
}
