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

  // 曾经在这里 `console.log` 整份 `meta.params`（用户自定义的运行参数，可能含密钥类默认值）：
  // 点击即触发、payload 无界，且与「有没有参数」这个判定无关——判定只需 `hasParams`。
  // 需要排查参数时用运行域自己的诊断入口，不要把用户数据整份打进控制台（CLAUDE.md 原则 4）。
  const onRunClick = useCallback(() => {
    if (hasParams) {
      setParamsDialogOpen(true);
    } else {
      handleRun();
    }
  }, [hasParams, handleRun]);

  const onParamsSubmit = useCallback(
    (values: Record<string, unknown>) => {
      setParamsDialogOpen(false);
      handleRun(values);
    },
    [handleRun],
  );

  return { workflowParams, hasParams, paramsDialogOpen, setParamsDialogOpen, onRunClick, onParamsSubmit };
}
