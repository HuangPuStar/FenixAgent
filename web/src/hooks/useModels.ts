import { useCallback, useEffect, useMemo, useState } from "react";
import type { ACPClient } from "../acp/client";
import type { ModelInfo, SessionModelState } from "../acp/types";

export interface UseModelsResult {
  supportsModelSelection: boolean;
  availableModels: ModelInfo[];
  currentModelId: string | null;
  currentModel: ModelInfo | null;
  setModel: (modelId: string) => Promise<void>;
  isLoading: boolean;
}

/**
 * Hook to manage model selection state.
 * Uses event-driven updates via ACPState EventEmitter.
 */
export function useModels(client: ACPClient): UseModelsResult {
  const [modelState, setModelState] = useState<SessionModelState | null>(client.state.modelState);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const handler = (state: SessionModelState | null) => {
      setModelState(state);
      setIsLoading(false);
      if (state && state.availableModels.length > 0) {
        const saved = localStorage.getItem("acp_model_id");
        if (saved && saved !== state.currentModelId && state.availableModels.some((m) => m.modelId === saved)) {
          try {
            client.setSessionModel(saved);
          } catch {
            /* ignore */
          }
        }
      }
    };

    client.state.on("modelStateChange", handler);
    return () => {
      client.state.off("modelStateChange", handler);
    };
  }, [client]);

  const availableModels = useMemo(() => modelState?.availableModels ?? [], [modelState]);

  const currentModelId = modelState?.currentModelId ?? null;

  const currentModel = useMemo(
    () => availableModels.find((m) => m.modelId === currentModelId) ?? null,
    [availableModels, currentModelId],
  );

  const setModel = useCallback(
    async (modelId: string) => {
      if (!modelState) throw new Error("Model selection not supported");
      setIsLoading(true);
      try {
        await client.setSessionModel(modelId);
        localStorage.setItem("acp_model_id", modelId);
      } catch (error) {
        setIsLoading(false);
        throw error;
      }
    },
    [client, modelState],
  );

  return {
    supportsModelSelection: modelState !== null && availableModels.length > 0,
    availableModels,
    currentModelId,
    currentModel,
    setModel,
    isLoading,
  };
}
