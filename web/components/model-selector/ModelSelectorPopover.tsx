import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import type { ACPClient } from "../../src/acp/client";
import type { ModelInfo } from "../../src/acp/types";
import { useModels } from "../../src/hooks/useModels";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { ModelSelectorPicker } from "./ModelSelectorPicker";

interface ModelSelectorPopoverProps {
  /** ACPClient instance for model state management */
  client: ACPClient;
  /** Callback when a model is selected */
  onModelSelect?: (modelId: string) => void;
  /** 只读模式：仅展示当前模型名，不渲染下拉与切换交互 */
  readOnly?: boolean;
}

/**
 * Model selector popover component.
 * readOnly 为 true 时降级为静态信息 chip（保留模型名，去掉下拉框）。
 * 非只读模式下，模型名称展示与只读相同，但双击可打开模型选择面板。
 */
export function ModelSelectorPopover({ client, onModelSelect, readOnly = false }: ModelSelectorPopoverProps) {
  const [open, setOpen] = useState(false);
  const { supportsModelSelection, availableModels, currentModel, setModel, isLoading } = useModels(client);

  const hasModels = supportsModelSelection && availableModels.length > 0;

  // Check if we're on a mobile device (touch-only)
  const isMobile =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: none) and (pointer: coarse)").matches;

  const handleSelect = async (model: ModelInfo) => {
    try {
      await setModel(model.modelId);
      onModelSelect?.(model.modelId);
      setOpen(false);
    } catch (error) {
      console.error("[ModelSelector] Failed to set model:", error);
    }
  };

  const handleDoubleClick = useCallback(() => {
    if (hasModels && !isLoading) {
      setOpen(true);
    }
  }, [hasModels, isLoading]);

  // 只读：静态展示当前模型名，无交互；无模型信息时不渲染
  if (readOnly) {
    if (!currentModel) return null;
    return (
      <span
        className="inline-flex items-center gap-1.5 h-7 px-2 text-xs text-muted-foreground"
        title={currentModel.name}
      >
        {isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        <span className="truncate">{currentModel.name}</span>
      </span>
    );
  }

  // 无模型时不渲染任何内容
  if (!currentModel) return null;

  return (
    <Popover open={open} onOpenChange={hasModels ? setOpen : undefined}>
      <PopoverAnchor asChild>
        <span
          className="inline-flex items-center gap-1.5 h-7 px-2 text-xs text-muted-foreground cursor-default select-none"
          title={currentModel.name}
          onDoubleClick={handleDoubleClick}
        >
          {isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          <span className="truncate">{currentModel.name}</span>
        </span>
      </PopoverAnchor>
      <PopoverContent className="w-72 p-0" align="end">
        <ModelSelectorPicker
          models={availableModels}
          currentModelId={currentModel?.modelId ?? null}
          onSelect={handleSelect}
          showSearch={!isMobile}
          isMobile={isMobile}
        />
      </PopoverContent>
    </Popover>
  );
}
