/**
 * Agent 侧边栏树的数据模型与纯派生工具。
 *
 * 从 `AgentSidebarTree.tsx` 拆出的第一层（§4.7 文件规模）：本模块只回答"树由什么组成、
 * 节点上能派生出什么"，不含请求、React 状态与渲染，因此可被排序测试与其它消费方直接引用。
 * `AgentSidebarTree.tsx` 仍转发 `orderInstancesByRunningStatus`，既有导入路径与导出面不变。
 */
import type { AgentNode, ResourceAccessActions, ResourceScopeView } from "@fenix/web-runtime/types/config";
import type { Environment, EnvironmentInstance } from "../types/index";

export interface AgentConfigItem {
  id: string;
  name: string;
  builtIn: boolean;
  model: string | null;
  modelId?: string | null;
  modelLabel?: string | null;
  description: string | null;
  /** 归属范围；缺失按本组织私有保守降级（授权判断只依据 `scope` + `access`）。 */
  scope?: ResourceScopeView;
  access?: { actions?: ResourceAccessActions };
  /** 归属组织展示名；身份名录不可用时后端整字段省略。 */
  organizationName?: string;
  agentNode: AgentNode;
}

export interface AgentTreeNode {
  agent: AgentConfigItem;
  environment: Environment | null;
  instances: EnvironmentInstance[];
}

/** 运行中实例稳定置前；其余状态保持 API 原始顺序。 */
export function orderInstancesByRunningStatus(instances: EnvironmentInstance[]): EnvironmentInstance[] {
  const running: EnvironmentInstance[] = [];
  const other: EnvironmentInstance[] = [];
  for (const instance of instances) {
    if (instance.status === "running") running.push(instance);
    else other.push(instance);
  }
  return [...running, ...other];
}

/** 实例状态点到样式的映射键；`unknown` 归入错误态（`.status-dot.error`）。 */
export function getInstanceStatus(instance: EnvironmentInstance) {
  if (instance.status === "running") return "running";
  if (instance.status === "starting") return "starting";
  if (instance.status === "unknown") return "error";
  return "stopped";
}

/** 该 agent 下可重启 / 需停止的实例（`running` 与 `starting` 同等对待）。 */
export function getRunningInstances(node: AgentTreeNode) {
  return node.instances.filter((inst) => inst.status === "running" || inst.status === "starting");
}
