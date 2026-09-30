// agent-config-port.ts — 本包对 Agent 配置执行节点与机器绑定关系的取数端口
//
// 为什么需要这一层：本包有两处业务意图的判据在 `agent_config` 里，但都不属于本包的领域——
//   1. 资源文件服务要回答「这个环境的文件请求发往哪台机器」，第一顺位是环境绑定的 Agent 配置声明的执行
//      节点（`agentNode` 优先、回退 `machineId` 列）；
//   2. 机器注册表删除前要确认「本组织没有 Agent 配置还绑在这台机器上」，注册时要把上报的 `agentName`
//      绑到这台机器。
// 节点解析优先级、`machine_id` 列的归属条件、「同名多条一起绑定」都是 Agent 配置的领域知识，归
// `@fenix/agent-config`（§4.8 第 7 条：调用期跨包写随表迁出收敛为 owner 的写入口）。
//
// 为什么改成端口：`agent_config` 表归 agent-config（§1.7 B7 已迁出宿主 schema），本包在调用期既不读它的
// 表对象（§6.1 的组装期例外只在各包 `db/` 内成立），也不得导入它的公开入口——那正是本轮消除的 §2.3
// 矩阵外反向边 `machine → agent-config`：它与 agent-config → agent-runtime、agent-runtime → sandbox、
// sandbox → machine 三条边共同闭合 4 包环族，本包一导入对方入口，环立刻重新闭合（台账条目
// `@fenix/resource-machine → @fenix/agent-config`，2026-09-24 随本端口落地删除）。
//
// 绑定方是宿主 `apps/server`，形态与 `host-port.ts` / `environment-port.ts` 一致（装配阶段一次绑定，用例
// 用浅合并替换层打桩）。与 `sandbox-route-port.ts` 的差别只在失败语义：本端口未绑定即失败，因为三件事都
// 有「取不到」与「确实没有」两种结果，静默降级会把用户文件写到默认机器上、或让仍被引用的机器被删掉。

/**
 * Agent 配置声明的执行节点。
 *
 * 与 agent-config 的 `AgentNode` 同形但不共享类型：本包只区分「哪台机器」与「哪个沙盒池」两种取值，把
 * 上游的字面量联合钉进本包契约，会让上游调整取值时无谓波及本包（与 `MachineEnvironmentRecord` 只声明四
 * 个字段同一条理由）。这里只出现**解析后**的节点，本包不重写解析规则（`agentNode` 优先、回退 `machineId`
 * 列、空值归一）——那是 agent-config 的一份实现。
 */
export type MachineAgentConfigNode =
  | { readonly kind: "machine"; readonly machineId: string }
  | { readonly kind: "sandbox"; readonly sandboxPoolId: string };

/** 按资源 ID 取执行节点的输入。 */
export interface MachineAgentConfigExecutionInput {
  readonly agentConfigId: string;
  /**
   * 该 Agent 配置必须所属的组织。
   *
   * 必填而非可选：机器文件路径上「环境绑定了一个 Agent 配置」不等于「该配置属于该环境所属组织」，缺了它
   * 就等于把归属校验降级为可选（§10.3 多租户隔离）。实现必须走 owner 的归属入口，不能在端口内自己比较。
   */
  readonly organizationId: string;
}

/** 机器注册路径的绑定输入（与 agent-config 的同名入口同形）。 */
export interface MachineAgentConfigBindInput {
  readonly organizationId: string;
  /** 机器上报的引擎名，是它与 Agent 配置之间唯一的身份线索。 */
  readonly agentName: string;
  readonly machineId: string;
}

/** Agent 配置的取数与绑定能力。 */
export interface MachineAgentConfigPort {
  /**
   * 按资源 ID 读执行节点，**同时校验归属**：配置不存在、或不属于 `organizationId` 时返回 null。
   *
   * 返回 null 是「按归属读不到」，调用方据此退回默认机器或本地 FS；实现侧不得为跨组织配置造值
   * （那会让 `organization_id` 的匹配条件形同不存在）。
   */
  getExecutionNode(input: MachineAgentConfigExecutionInput): Promise<MachineAgentConfigNode | null>;

  /** 该组织是否仍有 Agent 配置绑在这台机器上（机器删除前的悬空引用守卫，只回布尔不回行）。 */
  isAgentConfigBoundToMachine(organizationId: string, machineId: string): Promise<boolean>;

  /** 机器注册路径：把 `machineId` 写进本组织同名的 Agent 配置行。 */
  bindMachineIdByAgentName(input: MachineAgentConfigBindInput): Promise<void>;
}

/** 宿主绑定实现（装配阶段一次）。 */
let boundPort: MachineAgentConfigPort | null = null;
/** 用例替换值（浅合并，优先于宿主绑定）。 */
let override: Partial<MachineAgentConfigPort> | null = null;

/** 由 `apps/server` 在启动装配阶段绑定 Agent 配置取数实现。 */
export function bindMachineAgentConfigPort(port: MachineAgentConfigPort): void {
  if (boundPort && boundPort !== port) {
    throw new Error("MachineAgentConfigPort has already been bound");
  }
  boundPort = port;
}

/** 测试用：清空宿主绑定，让下个用例从干净状态重新绑定。 */
export function resetMachineAgentConfigPortForTest(): void {
  boundPort = null;
}

/**
 * 替换 Agent 配置取数实现（用例装配用）。
 *
 * 浅合并语义：只传需要替换的原语；传 `null` 恢复为宿主绑定实现。复位统一走
 * `@fenix/resource-machine/server/testing` 登记的 `registerStubResetter`，避免用例之间配置泄漏。
 */
export function setMachineAgentConfigPort(overrides: Partial<MachineAgentConfigPort> | null): void {
  override = overrides ? { ...override, ...overrides } : null;
}

/**
 * 读取当前生效的取数实现（用例替换值优先，否则为宿主绑定实现）。
 *
 * 未绑定时显式失败，不静默回退到「无节点 / 无引用」的默认实现：那会让文件请求落到默认机器上，或让仍被
 * Agent 配置引用的机器被删除。
 */
export function getMachineAgentConfigPort(): MachineAgentConfigPort {
  const getExecutionNode = override?.getExecutionNode ?? boundPort?.getExecutionNode;
  const isAgentConfigBoundToMachine = override?.isAgentConfigBoundToMachine ?? boundPort?.isAgentConfigBoundToMachine;
  const bindMachineIdByAgentName = override?.bindMachineIdByAgentName ?? boundPort?.bindMachineIdByAgentName;
  if (!getExecutionNode || !isAgentConfigBoundToMachine || !bindMachineIdByAgentName) {
    throw new Error("MachineAgentConfigPort has not been bound");
  }
  return { getExecutionNode, isAgentConfigBoundToMachine, bindMachineIdByAgentName };
}
