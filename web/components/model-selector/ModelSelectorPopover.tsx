import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { useState } from "react";
import type { ACPClient } from "../../src/acp/client";
import type { ModelInfo } from "../../src/acp/types";
import { useModels } from "../../src/hooks/useModels";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
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
 * Reference: Zed's AcpModelSelectorPopover that shows current model and allows switching.
 * readOnly 为 true 时降级为静态信息 chip（保留模型名，去掉下拉框）。
 */
export function ModelSelectorPopover({ client, onModelSelect, readOnly = false }: ModelSelectorPopoverProps) {
  const [open, setOpen] = useState(false);
  const { supportsModelSelection, availableModels, currentModel, setModel, isLoading } = useModels(client);

  // Always show the button — disable dropdown when no models available
  const hasModels = supportsModelSelection && availableModels.length > 0;

  // 只读：静态展示当前模型名，无下拉、无 hover、不可点击；无模型信息时不渲染
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

  // Check if we're on a mobile device (touch-only)
  const isMobile = typeof window !== "undefined" && window.matchMedia("(hover: none) and (pointer: coarse)").matches;

  const handleSelect = async (model: ModelInfo) => {
    try {
      await setModel(model.modelId);
      onModelSelect?.(model.modelId);
      setOpen(false);
    } catch (error) {
      console.error("[ModelSelector] Failed to set model:", error);
    }
  };

  return (
    <Popover open={open} onOpenChange={hasModels ? setOpen : undefined}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground hover:text-foreground h-7 px-2"
          disabled={!hasModels || isLoading}
        >
          {isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          <span className="truncate">{currentModel?.name ?? "Select Model"}</span>
          {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </Button>
      </PopoverTrigger>
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
