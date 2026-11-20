import { Copy, MessageSquareQuote } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../i18n/namespace";
import { readDomTextSelection, type TextSelection } from "./text-selection";

/** Native menus remain available whenever this file has no valid quote selection. */
export interface SelectionContextMenuProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  active?: boolean;
  resetKey?: unknown;
  onQuote?: (selection: TextSelection) => void;
  readSelection?: (event: MouseEvent) => TextSelection | null;
}

/** Scoped menu for selected file contents; captures text before moving focus. */
export function SelectionContextMenu({
  children,
  className,
  style,
  active = true,
  resetKey,
  onQuote,
  readSelection,
}: SelectionContextMenuProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const host = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ value: TextSelection; x: number; y: number } | null>(null);
  const [error, setError] = useState(false);
  const enabled = active && Boolean(onQuote);
  useLayoutEffect(() => {
    void resetKey;
    void enabled;
    setSelection(null);
  }, [enabled, resetKey]);
  useEffect(() => {
    if (!selection) return;
    const close = () => setSelection(null);
    const outside = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [selection]);
  useLayoutEffect(() => {
    if (!selection || !menu.current) return;
    const element = menu.current;
    element.style.left = `${Math.max(8, Math.min(selection.x, window.innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(selection.y, window.innerHeight - element.offsetHeight - 8))}px`;
    element.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [selection]);
  const copySelection = async () => {
    if (!selection) return;
    try {
      await navigator.clipboard.writeText(selection.value.text);
      setSelection(null);
    } catch (cause) {
      console.error("[selection] Clipboard write failed", cause instanceof Error ? cause.name : "UnknownError");
      setError(true);
    }
  };
  const itemClass =
    "flex min-h-8 w-full items-center gap-2 rounded-sm px-3 py-1.5 text-left text-sm hover:bg-surface-2 focus-visible:bg-surface-2";
  return (
    <div
      ref={host}
      className={className}
      style={style}
      onContextMenuCapture={(event) => {
        if (!enabled || !host.current) return;
        const value = readSelection
          ? readSelection(event.nativeEvent)
          : readDomTextSelection(host.current, event.nativeEvent);
        if (!value?.text.trim()) {
          setSelection(null);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setError(false);
        setSelection({
          value,
          x: event.clientX || host.current.getBoundingClientRect().left + 12,
          y: event.clientY || host.current.getBoundingClientRect().top + 12,
        });
      }}
    >
      {children}
      {enabled &&
        selection &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            data-selection-menu="true"
            aria-label={t("fileQuotes.actions")}
            className="fixed z-[1000] min-w-40 rounded-md border border-border-subtle bg-surface-1 p-1 shadow-lg"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setSelection(null);
                host.current?.focus({ preventScroll: true });
              }
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
                const index = items.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
                items[next]?.focus();
              }
            }}
          >
            <button
              role="menuitem"
              type="button"
              className={itemClass}
              onClick={() => {
                void copySelection();
              }}
            >
              <Copy aria-hidden="true" className="size-4" />
              {t("fileQuotes.copy")}
            </button>
            <button
              role="menuitem"
              type="button"
              data-selection-action="quote"
              className={itemClass}
              onClick={() => {
                const snapshot = selection.value;
                setSelection(null);
                onQuote?.(snapshot);
              }}
            >
              <MessageSquareQuote aria-hidden="true" className="size-4" />
              {t("fileQuotes.add")}
            </button>
            {error && (
              <p role="alert" className="px-3 py-1 text-xs text-red-500">
                {t("fileQuotes.copyFailed")}
              </p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
