import { FileText, Quote, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { createQuotePreview } from "../../src/lib/context-queue";
import type { FileAttachment, UserMessageImage } from "../../src/lib/types";

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
  const { t } = useTranslation("components");
  if (images.length === 0 && files.length === 0 && quotes.length === 0) return null;
  return (
    <div className="chat-composer-assets" role="group" aria-label={t("composerAssets.title")}>
      {images.map((image, index) => (
        <article key={`${image.mimeType}-${image.data.slice(0, 24)}`} className="chat-composer-asset">
          <img src={`data:${image.mimeType};base64,${image.data}`} alt={t("composerAssets.image")} />
          <strong>{t("composerAssets.imageNumber", { count: index + 1 })}</strong>
          <RemoveButton label={t("composerAssets.removeImage")} onClick={() => onRemoveImage(index)} />
        </article>
      ))}
      {files.map((file) => (
        <article key={file.path} className="chat-composer-asset">
          <span className="chat-composer-asset-icon">
            <FileText />
          </span>
          <strong title={file.name}>{file.name}</strong>
          <RemoveButton
            label={t("composerAssets.removeFile", { name: file.name })}
            onClick={() => onRemoveFile(file.path)}
          />
        </article>
      ))}
      {quotes.map((quote, index) => (
        <article key={quote.id} className="chat-composer-asset is-quote">
          <span className="chat-composer-asset-icon">
            <Quote />
          </span>
          <strong>{t("composerAssets.quoteNumber", { count: index + 1 })}</strong>
          <span className="chat-composer-quote-preview" role="tooltip">
            {createQuotePreview(quote.text)}
            {quote.omittedCharacterCount > 0 && (
              <small>{t("composerAssets.quoteTruncatedBadge", { count: quote.omittedCharacterCount })}</small>
            )}
          </span>
          {quote.omittedCharacterCount > 0 && <small aria-hidden="true">…</small>}
          <RemoveButton label={t("composerAssets.removeQuote")} onClick={() => onRemoveQuote(quote.id)} />
        </article>
      ))}
    </div>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="chat-composer-asset-remove" aria-label={label} onClick={onClick}>
      <X />
    </button>
  );
}
