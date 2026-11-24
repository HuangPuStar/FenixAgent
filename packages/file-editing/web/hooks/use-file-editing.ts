import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { EditingStore } from "./editing-store";
import type { FileEditingController, FileEditingOptions } from "./types";

export type { EditableKind, EditingBuffer, EditingGuard, FileEditingController, FileEditingOptions } from "./types";

/** Keeps drafts outside tab lifetimes and invalidates async work on every environment visit. */
export function useFileEditing({ environmentId, client, onSaved }: FileEditingOptions): FileEditingController {
  const storeRef = useRef<EditingStore | null>(null);
  if (!storeRef.current) storeRef.current = new EditingStore(client);
  const store = storeRef.current;
  store.client = client;
  store.onSaved = onSaved;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useLayoutEffect(() => {
    store.connect(environmentId);
    return () => store.suspend();
  }, [environmentId, store]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      // Read the current store before React has a chance to rerun effects for the first edit.
      if (!store.getSnapshot().dirtyPaths.length) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [store]);
  return {
    ...snapshot,
    ensureLoaded: store.ensureLoaded,
    updateContent: store.updateContent,
    markOfficeDirty: store.markOfficeDirty,
    registerOfficeSave: store.registerOfficeSave,
    save: store.save,
    reload: store.reload,
    overwrite: store.overwrite,
    cancelConflict: store.cancelConflict,
    refreshOffice: store.refreshOffice,
    requestClose: store.requestClose,
    requestReload: store.requestReload,
    beforeLeave: store.beforeLeave,
    guardPaths: store.guardPaths,
    resolveGuard: store.resolveGuard,
    notifyFileChange: store.notifyFileChange,
    notifyPathChange: store.notifyPathChange,
  };
}
