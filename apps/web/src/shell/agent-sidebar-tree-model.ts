/**
 * Agent 侧边栏树的数据模型与纯派生工具。
 *
 * 从 `AgentSidebarTree.tsx` 拆出的第一层（§4.7 文件规模）：本模块只回答"树由什么组成、
 * 节点上能派生出什么"，不含请求、React 状态与渲染，因此可被排序测试与其它消费方直接引用。
 * `AgentSidebarTree.tsx` 仍转发 `orderInstancesByRunningStatus`，既有导入路径与导出面不变。
 */
import type { StatusDotTone } from "@fenix/ui-components/ui/status-dot";
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

/**
 * 实例状态 → 圆点色调（`@fenix/ui-components/ui/status-dot` 的入参）。
 *
 * 返回色调而不是 CSS 类名/样式键：配色的权威在组件库，宿主只回答「跑着算好消息、
 * 起不来算坏消息」。此前返回的是页面 CSS 的 `.status-dot.<status>` 后缀（running / starting /
 * stopped / error），于是色值跟着 `agent-panel.css` 走、每个消费方各认一套状态词。
 *
 * `stopping` 与 `unknown` 的取舍：`stopping` 是过渡终态、不需要报警，与 `stopped` 同归 `neutral`；
 * `unknown`（后端没给状态）按 `danger` 处理，与迁移前的 `.status-dot.error` 一致。
 */
export function getInstanceStatusTone(instance: EnvironmentInstance): StatusDotTone {
  if (instance.status === "running") return "success";
  if (instance.status === "starting") return "warning";
  if (instance.status === "unknown") return "danger";
  return "neutral";
}

/** 该 agent 下可重启 / 需停止的实例（`running` 与 `starting` 同等对待）。 */
export function getRunningInstances(node: AgentTreeNode) {
  return node.instances.filter((inst) => inst.status === "running" || inst.status === "starting");
}
