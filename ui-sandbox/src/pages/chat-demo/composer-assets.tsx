import { FileText, Quote, X } from "lucide-react";
import { AssetArtwork } from "./asset-showcase";

export interface ComposerAsset {
  id: string;
  kind: "image" | "file" | "quote";
  name: string;
  meta: string;
  preview?: string;
}

export const DEFAULT_COMPOSER_ASSETS: readonly ComposerAsset[] = [
  { id: "layout-reference", kind: "image", name: "chat-layout-reference.png", meta: "428 KB" },
  { id: "site-spec", kind: "file", name: "site-component-spec.md", meta: "12 KB" },
];

export const EXTRA_COMPOSER_ASSET: ComposerAsset = {
  id: "interaction-notes",
  kind: "file",
  name: "interaction-notes.pdf",
  meta: "236 KB",
};

/** One shared preview strip for images and ordinary files attached to the next turn. */
export function ComposerAssets({
  assets,
  onRemove,
}: {
  assets: readonly ComposerAsset[];
  onRemove: (id: string) => void;
}) {
  if (assets.length === 0) return null;

  return (
    <div className="chat-demo__composer-assets" role="group" aria-label="待发送 Assets">
      {assets.map((asset) => (
        <article key={asset.id} className="chat-demo__composer-asset" data-kind={asset.kind}>
          <div className="chat-demo__composer-asset-visual">
            {asset.kind === "image" ? <AssetArtwork compact /> : asset.kind === "quote" ? <Quote /> : <FileText />}
          </div>
          <strong className="chat-demo__composer-asset-name">{asset.name}</strong>
          {asset.kind === "quote" && asset.preview && (
            <span className="chat-demo__composer-quote-preview">{asset.preview}</span>
          )}
          <button
            type="button"
            className="chat-demo__composer-asset-remove"
            aria-label={`移除 ${asset.name}`}
            onClick={() => onRemove(asset.id)}
          >
            <X />
          </button>
        </article>
      ))}
    </div>
  );
}
