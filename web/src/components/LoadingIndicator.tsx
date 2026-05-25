import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const SPINNER_FRAMES = ["·", "✢", "✱", "✶", "✻", "✽"];
const SPINNER_CYCLE = [...SPINNER_FRAMES, ...SPINNER_FRAMES.slice().reverse()];

interface LoadingIndicatorProps {
  verb?: string;
  stalled?: boolean;
}

export function LoadingIndicator({ verb, stalled = false }: LoadingIndicatorProps) {
  const { t } = useTranslation("components");
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef(Date.now());
  const displayVerb = verb ?? t("loading.thinking");

  // Spinner animation — 120ms per frame
  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_CYCLE.length);
    }, 120);
    return () => clearInterval(id);
  }, []);

  // Timer — 1s updates
  useEffect(() => {
    startTimeRef.current = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center gap-2.5 py-2">
      <span
        className="text-xl leading-none min-w-[1.2em] transition-colors duration-2000"
        style={{ color: stalled ? "var(--color-status-error)" : "var(--color-brand)" }}
      >
        {SPINNER_CYCLE[frame]}
      </span>
      <span
        className="animate-[glimmer-pulse_2s_ease-in-out_infinite] text-sm font-medium text-text-secondary transition-colors duration-2000"
        style={stalled ? undefined : undefined}
      >
        {displayVerb}…
      </span>
      <span className="ml-auto text-xs font-mono text-text-muted">{elapsed}s</span>
    </div>
  );
}
