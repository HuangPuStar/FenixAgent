import { useCallback, useEffect, useState } from "react";

/** A workspace can share one fullscreen choice across preview and editing views. */
export interface PageFullscreenState {
  fullscreen: boolean;
  toggleFullscreen: () => void;
  fullscreenClassName: string;
}

/** Expands a mounted panel inside the browser page without replacing its document or editor. */
export function usePageFullscreen(active = true): PageFullscreenState {
  const [fullscreen, setFullscreen] = useState(false);
  const toggleFullscreen = useCallback(() => setFullscreen((value) => !value), []);
  useEffect(() => {
    if (!active) setFullscreen(false);
  }, [active]);
  useEffect(() => {
    if (!fullscreen || !active) return;
    const handleEscape = (event: KeyboardEvent) => {
      const modal = document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]');
      if (event.key === "Escape" && !modal) setFullscreen(false);
    };
    // Editors and file trees can stop key propagation before it reaches the document.
    document.addEventListener("keydown", handleEscape, true);
    return () => document.removeEventListener("keydown", handleEscape, true);
  }, [fullscreen, active]);
  return {
    fullscreen: fullscreen && active,
    toggleFullscreen,
    fullscreenClassName: fullscreen && active ? "fixed inset-0 z-40 bg-background" : "",
  };
}
