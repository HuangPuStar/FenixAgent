import { useCallback, useEffect, useMemo, useState } from "react";
import type { ACPClient } from "../acp/client";
import type { SessionMode, SessionModeState } from "../acp/types";

export interface UseModesResult {
  supportsModeSelection: boolean;
  availableModes: SessionMode[];
  currentModeId: string | null;
  currentMode: SessionMode | null;
  setMode: (modeId: string) => void;
}

export function useModes(client: ACPClient): UseModesResult {
  const [modeState, setModeState] = useState<SessionModeState | null>(client.state.modeState);

  useEffect(() => {
    const handler = (state: SessionModeState | null) => {
      setModeState(state);
    };

    client.state.on("modeStateChange", handler);
    return () => {
      client.state.off("modeStateChange", handler);
    };
  }, [client]);

  const availableModes = useMemo(() => modeState?.availableModes ?? [], [modeState]);

  const currentModeId = modeState?.currentModeId ?? null;

  const currentMode = useMemo(
    () => availableModes.find((m) => m.id === currentModeId) ?? null,
    [availableModes, currentModeId],
  );

  const setMode = useCallback(
    (modeId: string) => {
      client.setSessionMode(modeId);
    },
    [client],
  );

  return {
    supportsModeSelection: modeState !== null && availableModes.length > 0,
    availableModes,
    currentModeId,
    currentMode,
    setMode,
  };
}
