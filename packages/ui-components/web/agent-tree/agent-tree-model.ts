/**
 * 侧栏智能体树（`AgentTree`）的视图结构与纯派生工具。
 *
 * 迁入自宿主 `apps/web/src/shell/agent-sidebar-tree-model.ts`（2026-09-28）：渲染与派生归本包，
 * 取数与四种领域操作（进入 / 重启 / 停止 / 删除）留在 owner 包 `@fenix/agent-config/web`。
 * 本包对 `@fenix/*` 保持零依赖，因此这里只声明**渲染所需的最小结构**：领域侧（agent 配置 +
 * 环境 + 实例三类 DTO）负责把资源解析成这里的视图项，权限判定（可写 / 可删 / 访问角标）也在那一侧完成。
 *
 * 本模块只含结构类型与纯函数：不请求、不依赖 React、不读 i18n，可被排序用例与其它消费方直接引用。
 */
import type { StatusDotTone } from "../ui/status-dot";

/** 实例行视图数据：只保留渲染与操作状态判定需要的字段。 */
export interface AgentTreeInstanceItem {
  /** 持久实例 id；同时是 chat 路由段与 rcsSessionId 的确定性来源（见宿主 `/agent/chat/{envId}/{instanceUid}`）。 */
  instanceUid: string;
  name: string;
  status: string;
}

/** agent 卡片视图数据：领域侧解析完显示名 / 访问角标 / 权限后喂给本组件。 */
export interface AgentTreeAgentItem {
  /** agent 配置 id：本组件的全部回调都以它为参数，领域侧据此查回自己的节点。 */
  id: string;
  /** 已解析的显示名；`前缀/名称` 形态由本组件按 `/` 拆分（左显示名、右标识键）。 */
  displayName: string;
  /** 访问级别角标键（`resource.*`，文案取自本包字典）；`resource.internal` 不展示徽标。 */
  accessBadgeKey: string;
  /** 只读资源：配置按钮显示「查看」而不是「配置」（图标由齿轮换成眼睛）。 */
  readOnly: boolean;
  /** 是否展示删除按钮（不可写与内置 agent 由领域侧判掉）。 */
  deletable: boolean;
  /** 远程执行节点标记（卡片右下角）。 */
  remote: boolean;
  /** 该 agent 当前绑定的环境 id；`null` 表示尚未创建（进入时由领域侧自动创建）。 */
  environmentId: string | null;
  instances: readonly AgentTreeInstanceItem[];
}

/** 正在进行的实例操作；用于让对应按钮转圈并禁用。 */
export interface AgentTreePendingInstance {
  id: string;
  type: "restart" | "stop";
}

export interface AgentTreeProps {
  agents: readonly AgentTreeAgentItem[];
  /** 首次加载中：整块替换为加载态。轮询刷新不置位，已有内容留在 DOM 里避免闪烁。 */
  initialLoading: boolean;
  /** 有请求在飞（含轮询）：为真时不渲染空态，避免「暂无可显示数据」与「正在取数」互相打断。 */
  fetching: boolean;
  selectedEnvironmentId?: string | null;
  selectedInstanceId?: string | null;
  /** 正在进入的 agent id：卡片禁用，避免重复进入同一份环境。 */
  enteringAgentId?: string | null;
  /** 正在重启 / 停止的实例：对应按钮转圈并禁用。 */
  pendingInstance?: AgentTreePendingInstance | null;
  onCreateAgent?: () => void;
  /** 进入 agent（点卡片）：落默认实例还是最近实例由领域侧决定。 */
  onEnterAgent: (agentId: string) => void;
  /** 进入指定实例（点实例行）。 */
  onEnterInstance: (agentId: string, instanceUid: string) => void;
  /** 新建实例：不选已有实例、直接派生一个。 */
  onSpawnInstance: (agentId: string) => void;
  /** 重启该 agent：无可重启实例时的提示、单实例直连与多实例弹窗都由领域侧决定。 */
  onRestartAgent: (agentId: string) => void;
  /** 重启指定实例（实例行的重启按钮）。 */
  onRestartInstance: (agentId: string, instanceUid: string) => void;
  /** 停止指定实例。 */
  onStopInstance: (instanceUid: string) => void;
  /** 配置 / 查看该 agent（只读时是「查看」）。 */
  onConfigureAgent?: (agentId: string) => void;
  /** 请求删除该 agent：确认弹窗的打开态与文案由领域侧持有。 */
  onDeleteAgent?: (agentId: string) => void;
}

/** 运行中实例稳定置前；其余状态保持原始顺序。 */
export function orderInstancesByRunningStatus(instances: readonly AgentTreeInstanceItem[]): AgentTreeInstanceItem[] {
  const running: AgentTreeInstanceItem[] = [];
  const other: AgentTreeInstanceItem[] = [];
  for (const instance of instances) {
    if (instance.status === "running") running.push(instance);
    else other.push(instance);
  }
  return [...running, ...other];
}

/**
 * 实例状态 → 圆点色调（`StatusDot` 的入参）。
 *
 * 返回色调而不是 CSS 类名 / 样式键：配色的权威在 `StatusDot`，调用方只回答「跑着算好消息、
 * 起不来算坏消息」。`stopping` 是过渡终态、不需要报警，与 `stopped` 同归 `neutral`；
 * `unknown`（后端没给状态）按 `danger` 处理。
 */
export function getInstanceStatusTone(instance: AgentTreeInstanceItem): StatusDotTone {
  if (instance.status === "running") return "success";
  if (instance.status === "starting") return "warning";
  if (instance.status === "unknown") return "danger";
  return "neutral";
}

/**
 * 可重启 / 需停止的实例（`running` 与 `starting` 同等对待）。
 *
 * 泛型只为**保元素类型**：领域侧传 `EnvironmentInstanceInfo[]`（多出的 `createdAt` 是它的字段）时
 * 拿回的仍是该类型，可以直接喂回 `instanceApi.restart({ id })` 这类领域调用；若返回窄结构，
 * 调用方要么把结果再断言回去、要么自己重写一遍同一个谓词。
 */
export function getRunningInstances<T extends AgentTreeInstanceItem>(instances: readonly T[]): T[] {
  return instances.filter((instance) => instance.status === "running" || instance.status === "starting");
}
