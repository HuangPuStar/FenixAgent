// web/components/knowledge/resource-preview-placeholders.tsx
// 预览区的**状态展示件**：骨架屏（Markdown / 文本）、失败占位、不支持类型的下载兜底。纯展示、不取数。
//
// 从 `ResourcePreviewContent.tsx` 拆出（§4.7）：这几件只吃文案与文件 URL，与「按类别分发渲染」无关；
// 同族的表格预览因自带取数与解析另成一档（`spreadsheet-preview.tsx`），但复用这里的失败占位。

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useTranslation } from "react-i18next";

export function MarkdownSkeleton() {
  return (
    <div className="flex-1 p-6 space-y-4">
      <Skeleton className="h-5 w-2/3 rounded-lg" />
      <Skeleton className="h-4 w-full rounded-lg" />
      <Skeleton className="h-4 w-[90%] rounded-lg" />
      <Skeleton className="h-4 w-[85%] rounded-lg" />
      <Skeleton className="h-4 w-3/4 rounded-lg" />
      <div className="pt-2 space-y-3">
        <Skeleton className="h-4 w-[70%] rounded-lg" />
        <Skeleton className="h-4 w-full rounded-lg" />
        <Skeleton className="h-4 w-[80%] rounded-lg" />
      </div>
    </div>
  );
}

export function TextSkeleton() {
  return (
    <div className="flex-1 p-6 space-y-3">
      <Skeleton className="h-3 w-full rounded-md" />
      <Skeleton className="h-3 w-[85%] rounded-md" />
      <Skeleton className="h-3 w-[92%] rounded-md" />
      <Skeleton className="h-3 w-[70%] rounded-md" />
      <Skeleton className="h-3 w-[78%] rounded-md" />
      <div className="pt-2 space-y-3">
        <Skeleton className="h-3 w-full rounded-md" />
        <Skeleton className="h-3 w-[88%] rounded-md" />
        <Skeleton className="h-3 w-[65%] rounded-md" />
        <Skeleton className="h-3 w-[75%] rounded-md" />
      </div>
    </div>
  );
}

export function PreviewPlaceholder({ message, tone = "danger" }: { message: string; tone?: "danger" | "neutral" }) {
  return (
    <EmptyState
      tone={tone}
      role={tone === "danger" ? "alert" : undefined}
      className="flex flex-1 flex-col items-center justify-center"
      title={message}
    />
  );
}

/**
 * 「该类型暂不支持预览」+ 下载兜底：office 降级与其余未知类型两处逐字相同，收成一份。
 *
 * 为什么不并进 `EmptyState` 的 `action`：`action` 只收 `Button` + `onClick`，而这里的下载语义是
 * `<a download>`（浏览器直接落盘、不发 XHR），用按钮包一个 `window.open` 会换掉浏览器行为。
 */
export function UnsupportedPreview({ fileUrl, filename }: { fileUrl: string; filename: string }) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-muted">
      <p className="text-sm">{t("preview.unsupported")}</p>
      <Button variant="outline" size="sm" asChild>
        <a href={fileUrl} download={filename} target="_blank" rel="noreferrer">
          {t("preview.download")}
        </a>
      </Button>
    </div>
  );
}
