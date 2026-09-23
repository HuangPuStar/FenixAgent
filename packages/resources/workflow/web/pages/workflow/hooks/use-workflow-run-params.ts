import { useCallback, useState } from "react";
import type { WfMeta } from "../yaml-utils";

/**
 * 运行按钮的**参数入口**：工作流声明了 `params` 就先问一遍，否则直接开跑。
 *
 * 「要不要弹参数对话框」和「弹完之后带参运行」是一件事的两半（对话框存在的唯一理由就是给 `handleRun`
 * 补齐入参），所以与 `useWorkflowRun` 分开放在这里：运行 hook 管命令与运行态，这里只管那颗按钮的
 * 前置流程与对话框开关。
 */
export interface UseWorkflowRunParamsParams {
  meta: WfMeta;
  handleRun: (params?: Record<string, unknown>) => Promise<void>;
}

export interface UseWorkflowRunParamsReturn {
  /** 传给运行参数对话框的参数定义（用户自定义 JSON） */
  workflowParams: Record<string, Record<string, unknown>> | undefined;
  hasParams: boolean | undefined;
  paramsDialogOpen: boolean;
  setParamsDialogOpen: (open: boolean) => void;
  onRunClick: () => void;
  onParamsSubmit: (values: Record<string, unknown>) => void;
}

export function useWorkflowRunParams({ meta, handleRun }: UseWorkflowRunParamsParams): UseWorkflowRunParamsReturn {
  const workflowParams = meta.params as Record<string, Record<string, unknown>> | undefined;
  const hasParams = workflowParams && Object.keys(workflowParams).length > 0;
  const [paramsDialogOpen, setParamsDialogOpen] = useState(false);

  const onRunClick = useCallback(() => {
    console.log("[RunButton] meta.params:", JSON.stringify(meta.params), "hasParams:", hasParams);
    if (hasParams) {
      setParamsDialogOpen(true);
    } else {
      handleRun();
    }
  }, [hasParams, handleRun, meta.params]);

  const onParamsSubmit = useCallback(
    (values: Record<string, unknown>) => {
      setParamsDialogOpen(false);
      handleRun(values);
    },
    [handleRun],
  );

  return { workflowParams, hasParams, paramsDialogOpen, setParamsDialogOpen, onRunClick, onParamsSubmit };
}
