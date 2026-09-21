import { Maximize2, Minimize2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "../../ui/dialog";

const PREVIEW_SIZES = [
  { key: "sm", labelKey: "small", w: "60vw", maxW: 800, h: "60vh", maxH: 600 },
  { key: "md", labelKey: "medium", w: "80vw", maxW: 1100, h: "75vh", maxH: 800 },
  { key: "lg", labelKey: "large", w: "92vw", maxW: 1500, h: "88vh", maxH: 960 },
  { key: "full", labelKey: "fullscreen", w: "98vw", maxW: 9999, h: "95vh", maxH: 9999 },
] as const;

/** Renders sandboxed inline site output with an optional resizable preview dialog. */
export function IframePreview({ src, width, height, title, ...rest }: Record<string, unknown>) {
  // 源实现从 common / components 两个命名空间取文案；包内合并为单一 uiComponents 命名空间
  // （键 preview / small / medium / large / fullscreen 与 message.* 同处一层），故只取一次 t。
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [expanded, setExpanded] = useState(false);
  const [sizeIdx, setSizeIdx] = useState(2);
  const size = PREVIEW_SIZES[sizeIdx];
  const passthroughProps = Object.fromEntries(
    Object.entries(rest).filter(([key]) => !["children", "node"].includes(key)),
  );

  return (
    <>
      <div className="relative group/iframe">
        <iframe
          src={src as string}
          width={(width as string | undefined) ?? "100%"}
          height={(height as string | undefined) ?? "400"}
          title={title as string}
          sandbox="allow-scripts allow-same-origin allow-popups"
          loading="lazy"
          style={{ border: "1px solid #e5e7eb", borderRadius: 8 }}
          {...passthroughProps}
        />
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="absolute top-2 right-2 p-1.5 rounded-md bg-white/80 dark:bg-gray-800/80 opacity-0 group-hover/iframe:opacity-100 transition-opacity hover:bg-white dark:hover:bg-gray-700 shadow-sm"
          title={t("message.expand")}
        >
          <Maximize2 className="h-5 w-5 text-gray-600 dark:text-gray-300" />
        </button>
      </div>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          showCloseButton={false}
          className="flex flex-col p-0 gap-0 overflow-hidden"
          style={{ width: size.w, maxWidth: size.maxW, height: size.h, maxHeight: size.maxH }}
        >
          <DialogHeader className="flex-row items-center justify-between px-3 py-2 border-b shrink-0 gap-2">
            <DialogTitle className="text-sm font-medium truncate">
              {(title as string | undefined) ?? t("preview")}
            </DialogTitle>
            <div className="flex items-center gap-1 shrink-0">
              <div className="flex items-center rounded-md border border-border/60 overflow-hidden">
                {PREVIEW_SIZES.map((previewSize, index) => (
                  <button
                    key={previewSize.key}
                    type="button"
                    onClick={() => setSizeIdx(index)}
                    className={`px-2 py-0.5 text-xs transition-colors ${
                      index === sizeIdx
                        ? "bg-brand text-white"
                        : "hover:bg-gray-100 dark:hover:bg-gray-700 text-text-secondary"
                    }`}
                  >
                    {t(previewSize.labelKey)}
                  </button>
                ))}
              </div>
              <DialogClose asChild>
                <button
                  type="button"
                  className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ml-1"
                  title={t("message.collapse")}
                >
                  <Minimize2 className="h-4 w-4" />
                </button>
              </DialogClose>
            </div>
          </DialogHeader>
          <div className="flex-1 min-h-0">
            <iframe
              src={src as string}
              title={title as string}
              sandbox="allow-scripts allow-same-origin allow-popups"
              className="w-full h-full border-0"
              {...passthroughProps}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
