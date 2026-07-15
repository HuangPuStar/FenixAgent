import { createContext, useContext } from "react";

export interface WorkflowPathConfig {
  /** 工作流列表页路径 */
  listPath: string;
  /** 编辑页路径函数 */
  editPath: (id: string) => string;
  /** 版本页路径函数 */
  versionsPath: (id: string) => string;
  /** 运行记录列表页路径 */
  runsPath: string;
}

/** agent panel 下的默认路径 */
const DEFAULT_AGENT_PATHS: WorkflowPathConfig = {
  listPath: "/agent/workflow",
  editPath: (id: string) => `/agent/workflow/${id}/edit`,
  versionsPath: (id: string) => `/agent/workflow/${id}/versions`,
  runsPath: "/agent/workflow",
};

export const WorkflowPathContext = createContext<WorkflowPathConfig>(DEFAULT_AGENT_PATHS);

/** 获取当前的工作流路径配置 */
export function useWorkflowPaths(): WorkflowPathConfig {
  return useContext(WorkflowPathContext);
}
