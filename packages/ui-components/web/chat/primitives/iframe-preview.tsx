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

/**
 * `src` 的协议白名单（前端规范 §6.2：Markdown / Agent 输出里的 `<iframe>` 必须去掉
 * `allow-same-origin` **且**对 `src` 做协议校验）。
 *
 * - 放行 `http:` / `https:` 与**无协议的相对地址**（由浏览器按当前源解析，只能落在本应用）；
 * - 拒绝 `javascript:` / `vbscript:` / `file:` / `blob:` / `about:` 与一切未知 scheme；
 * - `data:` 保留并附理由：data: 文档按其规范**永远是 opaque origin**，给不给 `allow-same-origin`
 *   都不会与父页面同源、拿不到父页面的 DOM 与存储；能逃逸的只有**同源**内容（`srcdoc` 与相对地址），
 *   而这条路径由「去掉 allow-same-origin + 组件固定 sandbox + 本校验」三重挡掉。包内 demo 依赖它做
 *   离线示例（`demo/sections/base-ui-p3/chat-descended.tsx`），宿主也用它渲染内联 HTML 预览。
 * - **移除条件**：宿主不再需要内联 HTML 预览（或收敛为站点卡片等受控组件）后，删掉数组里的 `data:`，
 *   同时把 demo 的示例改成同源地址。
 */
const ALLOWED_IFRAME_PROTOCOLS = ["http:", "https:", "data:"];

/**
 * 去掉 ASCII 控制符（含 TAB / CR / LF）与空格：浏览器解析 URL 前会先丢掉它们，
 * `java\nscript:alert(1)` 因此仍按 `javascript:` 执行，校验前必须做同样的规范化。
 * 用码点过滤而非正则字面量，规避 lint 的 `noControlCharactersInRegex` 规则。
 */
function stripControlCharsAndSpaces(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 0x20) out += value[i];
  }
  return out;
}

/**
 * 判断 `src` 能否交给 sandbox iframe 加载（Markdown 里的 `<iframe>` 由模型产出，属不可信输入）。
 *
 * 与 `micromark-util-sanitize-uri` 同口径：首个 `:` 落在 `/`、`?`、`#` 之后的不算协议（相对地址）。
 */
function isSafeIframeSrc(src: unknown): src is string {
  if (typeof src !== "string") return false;
  const normalized = stripControlCharsAndSpaces(src);
  if (normalized === "") return false;

  const colon = normalized.indexOf(":");
  if (colon === -1) return true;
  const slash = normalized.indexOf("/");
  const questionMark = normalized.indexOf("?");
  const numberSign = normalized.indexOf("#");
  if (
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign)
  ) {
    return true;
  }
  return ALLOWED_IFRAME_PROTOCOLS.includes(`${normalized.slice(0, colon).toLowerCase()}:`);
}

/**
 * Renders sandboxed inline site output with an optional resizable preview dialog.
 *
 * 沙箱取值由本组件固定（`sandbox` 从透传属性里剔除）：来源是 Agent / LLM 输出，模型不能靠
 * 自带 `sandbox` 属性把 `allow-same-origin` 加回来——那会与 `allow-scripts` 组成沙箱逃逸组合
 * （同源 iframe 内的脚本可以摘掉自己的 sandbox、读写父页面 DOM 与 sessionStorage）。
 */
export function IframePreview({ src, width, height, title, ...rest }: Record<string, unknown>) {
  // 源实现从 common / components 两个命名空间取文案；包内合并为单一 uiComponents 命名空间
  // （键 preview / small / medium / large / fullscreen 与 message.* 同处一层），故只取一次 t。
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [expanded, setExpanded] = useState(false);
  const [sizeIdx, setSizeIdx] = useState(2);
  const size = PREVIEW_SIZES[sizeIdx];
  const passthroughProps = Object.fromEntries(
    Object.entries(rest).filter(([key]) => !["children", "node", "sandbox"].includes(key)),
  );

  // 协议不合规的 `src` 整块不渲染：与 rehype-sanitize 的「剥掉不可信节点」同语义——
  // 宁可让消息里少一块预览，也不把不可信地址交进 iframe。
  if (!isSafeIframeSrc(src)) return null;

  return (
    <>
      <div className="relative group/iframe">
        <iframe
          src={src}
          width={(width as string | undefined) ?? "100%"}
          height={(height as string | undefined) ?? "400"}
          title={title as string}
          sandbox="allow-scripts allow-popups"
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
              src={src}
              title={title as string}
              sandbox="allow-scripts allow-popups"
              className="w-full h-full border-0"
              {...passthroughProps}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
