import { Button } from "@fenix/ui-components/ui/button";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EditingError, type OfficeSession } from "../../contracts";
import type { OfficeSavePreparation } from "../hooks/types";
import { FILE_EDITING_NS } from "../i18n/namespace";
import { loadOfficeScript, type OfficeEditorInstance } from "./office-script";
import { OfficeSyncBarrier } from "./office-sync-barrier";

/** The controller owns session termination; this view only owns the provider's iframe. */
export interface OfficeEditorProps {
  session: OfficeSession;
  onDirty(dirty: boolean): void;
  onError(message: string): void;
  onSave(): void;
  onPrepareSave?: (prepare: OfficeSavePreparation) => () => void;
  className?: string;
}
/** Keeps provider DOM isolated and destroys exactly the instance created by each effect. */
export function OfficeEditor({ session, onDirty, onError, onSave, onPrepareSave, className }: OfficeEditorProps) {
  const { t } = useTranslation(FILE_EDITING_NS);
  const container = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onDirty, onError, onSave, onPrepareSave });
  callbacks.current = { onDirty, onError, onSave, onPrepareSave };
  const [failed, setFailed] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [retry, setRetry] = useState(0);
  const initialization = session.initialization;
  useEffect(() => {
    void retry;
    const parent = container.current;
    if (!parent) return;
    const host = document.createElement("div");
    host.id = `office-${crypto.randomUUID()}`;
    host.className = "h-full";
    parent.appendChild(host);
    let disposed = false;
    let editor: OfficeEditorInstance | undefined;
    const synchronization = new OfficeSyncBarrier();
    let unregister: (() => void) | undefined;
    setFailed(false);
    setInitialized(false);
    void loadOfficeScript(initialization.scriptUrl)
      .then((api) => {
        if (disposed) return;
        const configuredEvents = initialization.config.events;
        const events = configuredEvents && typeof configuredEvents === "object" ? configuredEvents : {};
        editor = new api.DocEditor(host.id, {
          ...initialization.config,
          width: "100%",
          height: "100%",
          events: {
            ...events,
            onDocumentReady: () => {
              if (!disposed) synchronization.setReady();
            },
            onDocumentStateChange: (event: { data?: unknown }) => {
              if (!disposed && typeof event.data === "boolean") {
                synchronization.setSynchronized(!event.data);
                callbacks.current.onDirty(event.data);
              }
            },
            onError: () => {
              if (!disposed) {
                synchronization.fail(new EditingError("unavailable", "officeError"));
                setFailed(true);
                callbacks.current.onError(t("officeError"));
              }
            },
            onRequestSave: () => {
              if (!disposed) callbacks.current.onSave();
            },
          },
        });
        unregister = callbacks.current.onPrepareSave?.((signal) => synchronization.wait(signal));
        setInitialized(true);
      })
      .catch((error: unknown) => {
        console.error("[file-editing] Office editor initialization failed", error);
        if (!disposed) {
          setFailed(true);
          callbacks.current.onError(t("loadFailed"));
        }
      });
    return () => {
      disposed = true;
      unregister?.();
      synchronization.dispose();
      editor?.destroyEditor();
      host.remove();
    };
  }, [initialization, retry, t]);
  return (
    <section className={className} aria-label={t("officeTitle")}>
      {failed && (
        <div role="alert" className="flex items-center gap-2 p-3 text-sm text-red-500">
          {t("loadFailed")}
          {!initialized && (
            <Button variant="outline" size="sm" onClick={() => setRetry((old) => old + 1)}>
              {t("retry")}
            </Button>
          )}
        </div>
      )}
      <div ref={container} className="h-full" />
    </section>
  );
}
