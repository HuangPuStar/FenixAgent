import { AppWindow, ArrowUpRight, ChevronRight, Expand, Image as ImageIcon } from "lucide-react";
import { useState } from "react";
import Lightbox from "yet-another-react-lightbox";
import "yet-another-react-lightbox/styles.css";

const ASSET_ARTWORK_SRC = new URL("../../assets/chat-demo-artwork.svg", import.meta.url).href;

const SITE_FRAME_DOCUMENT = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:14px;font-family:system-ui,sans-serif;color:#1d2b45;background:#f7f9fc}.shell{max-width:340px;margin:auto}.eyebrow{color:#4374d8;font-size:8px;font-weight:700;letter-spacing:.12em}.hero{margin-top:7px;padding:13px;border-radius:12px;background:#fff;box-shadow:0 8px 24px rgba(35,55,90,.09)}h1{margin:0;font-size:16px}p{margin:6px 0 0;color:#68758c;font-size:9px;line-height:1.55}.row{display:flex;gap:5px;margin-top:9px}.chip{padding:4px 7px;border-radius:999px;color:#3765ba;background:#edf3ff;font-size:8px}</style></head><body><main class="shell"><span class="eyebrow">FENIX SITE COMPONENT</span><section class="hero"><h1>Chat 设计评审</h1><p>本地 srcDoc 预览，用于确认 Site 内容的尺寸与操作入口。</p><div class="row"><span class="chip">Local mock</span><span class="chip">Responsive</span></div></section></main></body></html>`;

/** Demonstrates rich response assets without any remote resource or online dependency. */
export function AssetShowcase() {
  const [imageOpen, setImageOpen] = useState(false);

  return (
    <div className="chat-demo__asset-showcase">
      <section className="chat-demo__response-image" aria-label="图片显示示例">
        <button type="button" className="chat-demo__response-image-open" onClick={() => setImageOpen(true)}>
          <AssetArtwork />
          <span className="chat-demo__response-image-expand">
            <Expand />
            查看原图
          </span>
        </button>
        <footer>
          <span className="chat-demo__response-image-name">
            <ImageIcon />
            chat-layout-reference.png
          </span>
          <small className="chat-demo__response-image-meta">1600 × 900 · 428 KB</small>
        </footer>
      </section>

      <section className="chat-demo__iframe-card" aria-label="iframe 显示示例">
        <header>
          <span>
            <AppWindow />
            Chat 设计评审站点
          </span>
          <button type="button" className="chat-demo__iframe-open" aria-label="在新窗口打开 iframe 示例">
            <ArrowUpRight />
          </button>
        </header>
        <iframe title="Chat 设计评审 Site 预览" sandbox="" srcDoc={SITE_FRAME_DOCUMENT} />
        <footer>
          <time dateTime="2026-08-25T09:41:00+08:00">今天 09:41</time>
          <button type="button">
            详情
            <ChevronRight />
          </button>
        </footer>
      </section>

      <Lightbox
        open={imageOpen}
        close={() => setImageOpen(false)}
        slides={[{ src: ASSET_ARTWORK_SRC, alt: "蓝色系 Chat 工作台概念图", width: 1280, height: 720 }]}
        carousel={{ finite: true }}
        controller={{ closeOnBackdropClick: true }}
        render={{ buttonPrev: () => null, buttonNext: () => null }}
      />
    </div>
  );
}

export function AssetArtwork({ compact = false }: { compact?: boolean }) {
  return (
    <img
      className="chat-demo__asset-artwork"
      data-compact={compact || undefined}
      src={ASSET_ARTWORK_SRC}
      alt="蓝色系 Chat 工作台概念图"
    />
  );
}
