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
    };

    client.state.on("modelStateChange", handler);
    return () => {
      client.state.off("modelStateChange", handler);
    };
  }, [client]);

  const availableModels = useMemo(() => modelState?.availableModels ?? [], [modelState]);

  const currentModelId = modelState?.currentModelId ?? null;

  // 先尝试在 availableModels 中查找；若未找到（如服务端返回的 currentModelId
  // 不在配置的模型列表中），构造一个使用 modelId 作为展示名的兜底对象，
  // 确保 UI 始终能显示当前模型标识，而不是空白。
  const currentModel = useMemo((): ModelInfo | null => {
    if (!currentModelId) return null;
    const found = availableModels.find((m) => m.modelId === currentModelId) ?? null;
    if (found) return found;
    // 兜底：模型不在列表中时，用 currentModelId 作为 name
    console.warn("[useModels] model not found in availableModels, using fallback name:", currentModelId);
    return { modelId: currentModelId, name: currentModelId };
  }, [availableModels, currentModelId]);

  const setModel = useCallback(
    async (modelId: string) => {
      if (!modelState) throw new Error("Model selection not supported");
      setIsLoading(true);
      try {
        await client.setSessionModel(modelId);
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
