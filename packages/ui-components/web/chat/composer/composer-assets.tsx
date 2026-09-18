import { FileText, Quote, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../lib/i18n";
import { createQuotePreview } from "../lib/context-queue";
import type { FileAttachment, UserMessageImage } from "../types";

/**
 * 待发送 Assets 行（图片、文件引用、聊天引用）。
 *
 * 来源：复制自 `packages/agent-runtime/web/components/chat/composer-assets.tsx`。
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
  return (
    <div className="chat-composer-assets" role="group" aria-label={t("chat.components.composerAssets.title")}>
      {images.map((image, index) => (
        <article key={`${image.mimeType}-${image.data.slice(0, 24)}`} className="chat-composer-asset">
          <img src={`data:${image.mimeType};base64,${image.data}`} alt={t("chat.components.composerAssets.image")} />
          <strong>{t("chat.components.composerAssets.imageNumber", { count: index + 1 })}</strong>
          <RemoveButton label={t("chat.components.composerAssets.removeImage")} onClick={() => onRemoveImage(index)} />
        </article>
      ))}
      {files.map((file) => (
        <article key={file.path} className="chat-composer-asset">
          <span className="chat-composer-asset-icon">
            <FileText />
          </span>
          <strong title={file.name}>{file.name}</strong>
          <RemoveButton
            label={t("chat.components.composerAssets.removeFile", { name: file.name })}
            onClick={() => onRemoveFile(file.path)}
          />
        </article>
      ))}
      {quotes.map((quote, index) => (
        <article key={quote.id} className="chat-composer-asset is-quote">
          <span className="chat-composer-asset-icon">
            <Quote />
          </span>
          <strong>{t("chat.components.composerAssets.quoteNumber", { count: index + 1 })}</strong>
          <span className="chat-composer-quote-preview" role="tooltip">
            {createQuotePreview(quote.text)}
            {quote.omittedCharacterCount > 0 && (
              <small>
                {t("chat.components.composerAssets.quoteTruncatedBadge", { count: quote.omittedCharacterCount })}
              </small>
            )}
          </span>
          {quote.omittedCharacterCount > 0 && <small aria-hidden="true">…</small>}
          <RemoveButton
            label={t("chat.components.composerAssets.removeQuote")}
            onClick={() => onRemoveQuote(quote.id)}
          />
        </article>
      ))}
    </div>
  );
}

/** Assets 行右上角的移除按钮（源实现逐字保留）。 */
function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="chat-composer-asset-remove" aria-label={label} onClick={onClick}>
      <X />
    </button>
  );
}
