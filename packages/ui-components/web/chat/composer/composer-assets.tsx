import "./composer-assets.css";

import { FileText, Quote, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { createQuotePreview } from "../lib/context-queue";
import type { FileAttachment, UserMessageImage } from "../types";
import { QuoteTruncatedBadge } from "./quote-truncated-badge";

/**
 * 待发送 Assets 行（图片、文件引用、聊天引用）。
 *
 * 来源：复制自 `packages/agent-runtime/web/components/chat/composer-assets.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 * 纯化改动点：`react-i18next` 命名空间 `components` → 包内 `UI_COMPONENTS_NS`，
 * 文案键按 `chat.components.composerAssets.*` 搬运；`@/src/lib/context-queue` →
 * `../lib/context-queue`；其余结构、类名、图标与文案插值逐字保留。
 *
 * 样式下沉（2026-09-22，禁令 FCP-WEB-02/03）：卡片基准宽度、图标尺寸、移除按钮的触屏常驻与
 * 引用预览浮层的定位搬进同目录 `composer-assets.css`（类名 `.chat-composer-tile*` /
 * `.chat-composer-quote-tooltip`），扁平工具类仍留在下方 `className`。
 */

/** 输入岛中待发送的单条聊天引用。 */
export interface ComposerQuote {
  id: string;
  text: string;
  omittedCharacterCount: number;
}

interface ComposerAssetsProps {
  images: UserMessageImage[];
  files: FileAttachment[];
  quotes: ComposerQuote[];
  onRemoveImage: (index: number) => void;
  onRemoveFile: (path: string) => void;
  onRemoveQuote: (id: string) => void;
}

/** 图片、文件与引用共用的待发送 Assets 行。 */
export function ComposerAssets({
  images,
  files,
  quotes,
  onRemoveImage,
  onRemoveFile,
  onRemoveQuote,
}: ComposerAssetsProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  if (images.length === 0 && files.length === 0 && quotes.length === 0) return null;
  // 源样式表的共享声明：`.chat-composer-asset` 基类、`> img` 与 `-icon` 的同一组声明、`-remove` 按钮。
  // 需要子代选择器 / 手写媒体查询的那部分（图标尺寸、触屏常驻、预览浮层定位）在同目录 `composer-assets.css`。
  const assetClass = "chat-composer-tile group relative w-19";
  const previewClass = "grid h-14.5 w-16 place-items-center rounded-md bg-slate-100 object-cover";
  const labelClass = "mt-1 block w-16 overflow-hidden text-3xs text-ellipsis whitespace-nowrap text-slate-600";
  const removeClass =
    "chat-composer-tile-remove absolute -top-1.5 right-1 grid h-5.5 w-5.5 place-items-center rounded-full bg-gray-700 text-white opacity-0 [transition:opacity_120ms_ease] group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100";
  return (
    <div
      className="flex flex-wrap gap-2.25 overflow-visible px-3.5 pt-3 pb-1"
      role="group"
      aria-label={t("chat.components.composerAssets.title")}
    >
      {images.map((image, index) => (
        <article
          key={`${image.mimeType}-${image.data.slice(0, 24)}`}
          className={assetClass}
          data-slot="chat-composer-asset"
        >
          {/* 展示地址与消息气泡同规则：优先 `url`，缺省时用 base64 载荷拼 data URL。 */}
          <img
            className={previewClass}
            src={image.url ?? `data:${image.mimeType};base64,${image.data}`}
            alt={t("chat.components.composerAssets.image")}
          />
          <strong className={labelClass}>
            {t("chat.components.composerAssets.imageNumber", { count: index + 1 })}
          </strong>
          <RemoveButton
            className={removeClass}
            label={t("chat.components.composerAssets.removeImage")}
            onClick={() => onRemoveImage(index)}
          />
        </article>
      ))}
      {files.map((file) => (
        <article key={file.path} className={assetClass} data-slot="chat-composer-asset">
          <span className={`${previewClass} chat-composer-tile-preview text-slate-500`}>
            <FileText />
          </span>
          <strong className={labelClass} title={file.name}>
            {file.name}
          </strong>
          <RemoveButton
            className={removeClass}
            label={t("chat.components.composerAssets.removeFile", { name: file.name })}
            onClick={() => onRemoveFile(file.path)}
          />
        </article>
      ))}
      {quotes.map((quote, index) => (
        <article key={quote.id} className={`${assetClass} w-19 min-w-19 basis-19`} data-slot="chat-composer-quote">
          <span className={`${previewClass} chat-composer-tile-preview text-slate-500`}>
            <Quote />
          </span>
          <strong className={labelClass}>
            {t("chat.components.composerAssets.quoteNumber", { count: index + 1 })}
          </strong>
          <span
            className="chat-composer-quote-tooltip absolute left-0 z-20 hidden max-h-30 overflow-hidden rounded-md border border-slate-200 bg-white px-2.75 py-2.25 text-left text-xs leading-normal text-slate-600 [overflow-wrap:anywhere] group-hover:block group-focus-within:block"
            data-slot="chat-composer-quote-preview"
            role="tooltip"
          >
            {createQuotePreview(quote.text)}
            <QuoteTruncatedBadge omittedCharacterCount={quote.omittedCharacterCount} />
          </span>
          {quote.omittedCharacterCount > 0 && (
            // 引用被截断时右上角的溢出角标（源 `.chat-composer-asset.is-quote > small`）。
            <small
              className="absolute top-0.75 left-12 grid h-4 w-4 place-items-center rounded-full bg-blue-100 text-3xs font-bold text-slate-500"
              aria-hidden="true"
            >
              …
            </small>
          )}
          <RemoveButton
            className={removeClass}
            label={t("chat.components.composerAssets.removeQuote")}
            onClick={() => onRemoveQuote(quote.id)}
          />
        </article>
      ))}
    </div>
  );
}

/** Assets 行右上角的移除按钮（源实现逐字保留）。 */
function RemoveButton({ label, onClick, className }: { label: string; onClick: () => void; className: string }) {
  return (
    <button type="button" className={className} aria-label={label} onClick={onClick}>
      <X />
    </button>
  );
}
