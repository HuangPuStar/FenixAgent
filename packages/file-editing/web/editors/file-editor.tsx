import { SelectionContextMenu } from "@fenix/ui-components/components/selection-context-menu";
import { hitsVisibleTextSelection, type TextSelection } from "@fenix/ui-components/components/text-selection";
import { UI_COMPONENTS_NS } from "@fenix/ui-components/i18n";
import { Button } from "@fenix/ui-components/ui/button";
import type { EditorView } from "codemirror";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FILE_EDITING_NS } from "../i18n/namespace";
import { type EditorLanguageId, loadEditorLanguage } from "./editor-language";

let editorModule: Promise<typeof import("codemirror")> | null = null;
function loadEditorModule() {
  editorModule ??= import("codemirror").catch((error: unknown) => {
    editorModule = null;
    throw error;
  });
  return editorModule;
}
/** Controlled source editor; programmatic replacement never marks a draft dirty. */
export interface FileEditorProps {
  value: string;
  language: EditorLanguageId;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onSave?: () => void;
  className?: string;
  active?: boolean;
  onQuoteSelection?: (selection: TextSelection) => void;
}
const theme = {
  "&": {
    height: "100%",
    color: "var(--color-text-primary)",
    fontSize: "var(--text-xs)",
    backgroundColor: "transparent",
  },
  ".cm-content": { fontFamily: "var(--font-mono)", caretColor: "var(--color-brand)", padding: "8px 0" },
  ".cm-scroller": { overflow: "auto" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--color-text-muted)",
    borderRight: "1px solid var(--color-border)",
  },
  // CodeMirror paints selection behind the line, so an opaque line tint would hide it.
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--color-text-muted) 12%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "color-mix(in srgb, var(--color-brand) 25%, transparent)" },
};
/** Mounts CodeMirror lazily and releases each instance symmetrically in StrictMode. */
export function FileEditor({
  value,
  language,
  readOnly = false,
  onChange,
  onSave,
  className,
  active = true,
  onQuoteSelection,
}: FileEditorProps) {
  const { t } = useTranslation(FILE_EDITING_NS);
  const { t: tUI } = useTranslation(UI_COMPONENTS_NS);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const current = useRef(value);
  const replacing = useRef(false);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    void retry;
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let ownedView: EditorView | null = null;
    setFailed(false);
    void Promise.all([loadEditorModule(), loadEditorLanguage(language)])
      .then(([{ basicSetup, EditorView: View }, extension]) => {
        if (disposed) return;
        ownedView = new View({
          doc: current.current,
          parent: container,
          extensions: [
            basicSetup,
            extension ?? [],
            View.lineWrapping,
            View.theme(theme),
            View.editable.of(!readOnly),
            View.updateListener.of((update) => {
              if (!update.docChanged || replacing.current) return;
              current.current = update.state.doc.toString();
              callbacks.current.onChange(current.current);
            }),
            View.domEventHandlers({
              keydown: (event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                  event.preventDefault();
                  event.stopPropagation();
                  callbacks.current.onSave?.();
                  return true;
                }
                return false;
              },
            }),
          ],
        });
        viewRef.current = ownedView;
      })
      .catch((error: unknown) => {
        console.error("[file-editing] Source editor initialization failed", error);
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      ownedView?.destroy();
      if (viewRef.current === ownedView) viewRef.current = null;
    };
  }, [language, readOnly, retry]);
  // Rejected edits can rerender with the same accepted value, so reconcile after every render.
  useEffect(() => {
    if (value === current.current) return;
    current.current = value;
    const view = viewRef.current;
    if (!view) return;
    replacing.current = true;
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    } finally {
      replacing.current = false;
    }
  });
  return (
    <SelectionContextMenu
      className={className}
      active={active}
      onQuote={onQuoteSelection}
      readSelection={(event) => {
        const view = viewRef.current;
        if (!view?.dom.contains(event.target as Node)) return null;
        const range = view.state.selection.main;
        if (range.empty || view.state.selection.ranges.length !== 1) return null;
        if (!hitsVisibleTextSelection(view.dom, event, ".cm-selectionBackground")) return null;
        const keyboard = event.clientX === 0 && event.clientY === 0 && event.button === 0;
        const position = keyboard ? range.from : view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position === null || position < range.from || position > range.to) return null;
        return {
          text: view.state.sliceDoc(range.from, range.to),
          location: tUI("fileQuotes.lines", {
            start: view.state.doc.lineAt(range.from).number,
            end: view.state.doc.lineAt(range.to > range.from ? range.to - 1 : range.to).number,
          }),
        };
      }}
    >
      <div ref={containerRef} className={failed ? "hidden" : "h-full"} />
      {failed && (
        <div role="alert" className="flex items-center gap-2 p-4 text-sm text-red-500">
          {t("loadFailed")}
          <Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
            {t("retry")}
          </Button>
        </div>
      )}
    </SelectionContextMenu>
  );
}
