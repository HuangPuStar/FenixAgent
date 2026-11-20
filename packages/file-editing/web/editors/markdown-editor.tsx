import { Button } from "@fenix/ui-components/ui/button";
import type { Crepe as CrepeInstance } from "@milkdown/crepe";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FILE_EDITING_NS } from "../i18n/namespace";

let modules: Promise<
  [
    typeof import("@milkdown/crepe"),
    typeof import("@milkdown/kit/core"),
    typeof import("./markdown-frontmatter"),
    typeof import("@milkdown/kit/prose/state"),
  ]
> | null = null;
function loadModules() {
  modules ??= Promise.all([
    import("@milkdown/crepe"),
    import("@milkdown/kit/core"),
    import("./markdown-frontmatter"),
    import("@milkdown/kit/prose/state"),
    import("@milkdown/crepe/theme/common/style.css"),
  ])
    .then(
      ([crepe, core, frontmatter, prose]) =>
        [crepe, core, frontmatter, prose] as [typeof crepe, typeof core, typeof frontmatter, typeof prose],
    )
    .catch((error: unknown) => {
      modules = null;
      throw error;
    });
  return modules;
}
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Image read failed"));
    reader.readAsDataURL(file);
  });
}
const theme: Record<string, string> = {
  "--crepe-color-background": "var(--color-background)",
  "--crepe-color-on-background": "var(--color-text-primary)",
  "--crepe-color-surface": "var(--color-surface-1)",
  "--crepe-color-surface-low": "var(--color-surface-2)",
  "--crepe-color-on-surface": "var(--color-text-secondary)",
  "--crepe-color-on-surface-variant": "var(--color-text-muted)",
  "--crepe-color-outline": "var(--color-text-muted)",
  "--crepe-color-primary": "var(--color-brand)",
  "--crepe-color-secondary": "var(--color-brand-subtle)",
  "--crepe-color-on-secondary": "var(--color-brand)",
  "--crepe-color-inverse": "var(--color-bg-inverted)",
  "--crepe-color-on-inverse": "var(--color-text-inverted)",
  "--crepe-color-inline-code": "var(--color-status-error)",
  "--crepe-color-error": "var(--color-status-error)",
  "--crepe-color-hover": "var(--color-surface-hover)",
  "--crepe-color-selected": "var(--color-surface-2)",
  "--crepe-color-inline-area": "var(--color-surface-2)",
  "--crepe-font-default": "var(--font-sans)",
  "--crepe-font-title": "var(--font-sans)",
  "--crepe-font-code": "var(--font-mono)",
};
/** Markdown view accepts source so external reload and metadata preservation share one authority. */
export interface MarkdownEditorProps {
  value: string;
  readOnly?: boolean;
  onChange(markdown: string): void;
  /** Register a synchronous draft flush before switching editors or saving. */
  onRegisterFlush?: (flush: () => void) => () => void;
  className?: string;
}
/** Creates rich Markdown only after its DOM exists; initialization never marks a draft dirty. */
export function MarkdownEditor({ value, readOnly = false, onChange, onRegisterFlush, className }: MarkdownEditorProps) {
  const { t } = useTranslation(FILE_EDITING_NS);
  const container = useRef<HTMLDivElement>(null);
  const current = useRef(value);
  const callbacks = useRef({ onChange, onRegisterFlush });
  callbacks.current = { onChange, onRegisterFlush };
  const [revision, setRevision] = useState(0);
  const [failed, setFailed] = useState(false);
  // Rejected edits keep the accepted prop unchanged; a rerender must still restore the document.
  useEffect(() => {
    if (current.current !== value) {
      current.current = value;
      setRevision((old) => old + 1);
    }
  });
  useEffect(() => {
    void revision;
    const parent = container.current;
    if (!parent) return;
    const host = document.createElement("div");
    host.className = "h-full";
    parent.appendChild(host);
    let disposed = false;
    let ready = false;
    let instance: CrepeInstance | undefined;
    let unregisterFlush: (() => void) | undefined;
    setFailed(false);
    const initialized = loadModules()
      .then(
        async ([
          { Crepe },
          { editorViewOptionsCtx, editorViewCtx, prosePluginsCtx },
          { createMarkdownFrontmatterPlugins, preserveRawFrontmatter },
          { Plugin },
        ]) => {
          if (disposed) return;
          const original = current.current;
          instance = new Crepe({
            root: host,
            defaultValue: original,
            featureConfigs: {
              placeholder: { text: t("markdownPlaceholder") },
              "image-block": { onUpload: fileToDataUrl },
            },
          });
          // 初始化期间会忽略规范化事件，因此先阻止输入，避免首笔编辑丢失。
          instance.setReadonly(true);
          instance.editor.config((ctx) =>
            ctx.update(editorViewOptionsCtx, (options) => ({
              ...options,
              attributes: (state) => {
                const attrs = typeof options.attributes === "function" ? options.attributes(state) : options.attributes;
                return { ...attrs, class: `${attrs?.class ?? ""} min-w-0 w-full max-w-none pl-22! pr-5! py-5!` };
              },
            })),
          );
          instance.editor.use(createMarkdownFrontmatterPlugins(t("frontmatter")));
          let synchronizedDoc: ProseNode | undefined;
          const publish = (markdown: string) => {
            if (!instance) return;
            synchronizedDoc = instance.editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
            current.current = preserveRawFrontmatter(current.current, markdown);
            callbacks.current.onChange(current.current);
          };
          const flush = () => {
            if (disposed || !ready || !instance) return;
            const doc = instance.editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
            // Selection changes and untouched documents must not normalize the original Markdown source.
            if (!synchronizedDoc?.eq(doc)) publish(instance.getMarkdown());
          };
          // Milkdown listeners debounce document changes; leave guards need the first transaction immediately.
          instance.editor.config((ctx) =>
            ctx.update(prosePluginsCtx, (plugins) => [
              ...plugins,
              new Plugin({
                view: () => ({
                  update: (view, previous) => {
                    if (!view.state.doc.eq(previous.doc)) flush();
                  },
                }),
              }),
            ]),
          );
          instance.on((api) => api.blur(flush));
          await instance.create();
          if (disposed) return;
          synchronizedDoc = instance.editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
          ready = true;
          instance.setReadonly(readOnly);
          unregisterFlush = callbacks.current.onRegisterFlush?.(flush);
        },
      )
      .catch((error: unknown) => {
        console.error("[file-editing] Markdown editor initialization failed", error);
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      unregisterFlush?.();
      // Crepe mutates its host while creating; destroy only after that asynchronous work settles.
      void initialized
        .then(async () => {
          await instance?.destroy();
          host.remove();
        })
        .catch((error: unknown) => {
          console.error("[file-editing] Markdown editor cleanup failed", error);
          host.remove();
        });
    };
  }, [revision, readOnly, t]);
  return (
    <div className={className} style={theme}>
      <div ref={container} className={failed ? "hidden" : "h-full"} />
      {failed && (
        <div role="alert" className="flex items-center gap-2 p-4 text-sm text-red-500">
          {t("loadFailed")}
          <Button variant="outline" size="sm" onClick={() => setRevision((old) => old + 1)}>
            {t("retry")}
          </Button>
        </div>
      )}
    </div>
  );
}
