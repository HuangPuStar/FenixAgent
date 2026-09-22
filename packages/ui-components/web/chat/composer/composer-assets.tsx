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
  const assetClass = "group relative w-[76px] flex-[0_0_76px]";
  const previewClass = "grid h-[58px] w-16 place-items-center rounded-[9px] bg-[#f1f4f8] object-cover";
  const labelClass = "mt-1 block w-16 overflow-hidden text-[10px] text-ellipsis whitespace-nowrap text-[#526178]";
  const removeClass =
    "absolute -top-[6px] right-1 grid h-[22px] w-[22px] place-items-center rounded-full bg-[#3d485b] text-white opacity-0 [transition:opacity_120ms_ease] group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 [&>svg]:w-[13px]";
  return (
    <div
      className="flex flex-wrap gap-[9px] overflow-visible px-[14px] pt-3 pb-1"
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
          <span className={`${previewClass} [&>svg]:w-[23px] [&>svg]:text-[#4d72b2]`}>
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
        <article
          key={quote.id}
          className={`${assetClass} w-[76px] min-w-[76px] basis-[76px]`}
          data-slot="chat-composer-quote"
        >
          <span className={`${previewClass} [&>svg]:w-[23px] [&>svg]:text-[#4d72b2]`}>
            <Quote />
          </span>
          <strong className={labelClass}>
            {t("chat.components.composerAssets.quoteNumber", { count: index + 1 })}
          </strong>
          <span
            className="absolute bottom-[calc(100%+8px)] left-0 z-20 hidden w-[min(320px,calc(100vw-48px))] max-h-[120px] overflow-hidden rounded-[9px] border border-[#dfe5ed] bg-white px-[11px] py-[9px] text-left text-[12px] leading-[1.5] text-[#526178] shadow-[0_8px_24px_rgb(38_52_77_/_14%)] [overflow-wrap:anywhere] group-hover:block group-focus-within:block"
            data-slot="chat-composer-quote-preview"
            role="tooltip"
          >
            {createQuotePreview(quote.text)}
            <QuoteTruncatedBadge omittedCharacterCount={quote.omittedCharacterCount} />
          </span>
          {quote.omittedCharacterCount > 0 && (
            // 引用被截断时右上角的溢出角标（源 `.chat-composer-asset.is-quote > small`）。
            <small
              className="absolute top-[3px] left-12 grid h-4 w-4 place-items-center rounded-full bg-[#dbe8f8] text-[11px] font-bold text-[#4d72b2]"
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
