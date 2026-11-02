// agent-config-port.ts — 本包对 Agent 配置执行节点与机器绑定关系的取数端口
//
// 为什么需要这一层：本包有两处业务意图的判据在 `agent_config` 里，但都不属于本包的领域——
//   1. 资源文件服务要回答「这个环境的文件请求发往哪台机器」，第一顺位是环境绑定的 Agent 配置声明的执行
//      节点（`agentNode` 优先、回退 `machineId` 列）；
//   2. 机器注册表删除前要确认「本组织没有 Agent 配置还绑在这台机器上」。
// 节点解析优先级与 `machine_id` 列的归属条件都是 Agent 配置的领域知识，归 `@fenix/agent-config`。
//
// 为什么改成端口：`agent_config` 表归 agent-config（§1.7 B7 已迁出宿主 schema），本包在调用期既不读它的
// 表对象（§6.1 的组装期例外只在各包 `db/` 内成立），也不得导入它的公开入口——那正是本轮消除的 §2.3
// 矩阵外反向边 `machine → agent-config`：它与 agent-config → agent-runtime、agent-runtime → sandbox、
// sandbox → machine 三条边共同闭合 4 包环族，本包一导入对方入口，环立刻重新闭合（台账条目
// `@fenix/resource-machine → @fenix/agent-config`，2026-09-24 随本端口落地删除）。
//
// 绑定方是宿主 `apps/server`，形态与 `host-port.ts` / `environment-port.ts` 一致（装配阶段一次绑定，用例
// 用浅合并替换层打桩）。与 `sandbox-route-port.ts` 的差别只在失败语义：本端口未绑定即失败，因为两件事都
// 有「取不到」与「确实没有」两种结果，静默降级会把用户文件写到默认机器上、或让仍被引用的机器被删掉。
//
// 执行节点读取**不按组织收窄**：显式机器 / 显式沙盒池是 Agent 配置的依赖，Agent 被跨组织共享时，
// 使用方拿到的就是它在启动路径上解析出的同一节点，否则文件请求会落到默认机器或本地，与实例运行的位置
// 分裂。授权发生在更上游（环境属主校验、绑定 Agent 时的可见性校验），本端口只回答「这个配置声明的节点
// 是什么、它属于哪个组织」，不承担权限判定。

/**
 * Agent 配置声明的执行节点。
 *
 * 与 agent-config 的 `AgentNode` 同形但不共享类型：本包只区分「哪台机器」与「哪个沙盒池」两种取值，把
 * 上游的字面量联合钉进本包契约，会让上游调整取值时无谓波及本包（与 `MachineEnvironmentRecord` 只声明四
 * 个字段同一条理由）。这里只出现**解析后**的节点，本包不重写解析规则（`agentNode` 优先、回退 `machineId`
 * 列、空值归一）——那是 agent-config 的一份实现。
 *
 * `organizationId` 是**节点所属组织**（Agent 配置的归属），与环境所属组织可能不同：显式沙盒池要按池的
 * 归属组织解析。默认池不走这里——未声明节点时环境根本没有节点可取。
 */
export type MachineAgentConfigNode =
  | { readonly kind: "machine"; readonly machineId: string; readonly organizationId: string }
  | { readonly kind: "sandbox"; readonly sandboxPoolId: string; readonly organizationId: string };

/** 按资源 ID 取执行节点的输入。 */
export interface MachineAgentConfigExecutionInput {
  readonly agentConfigId: string;
}

/** Agent 配置的执行节点与机器引用查询能力。 */
export interface MachineAgentConfigPort {
  /**
   * 按资源 ID 读执行节点，**不做组织收窄**：配置不存在（已删除）或未声明任何节点时返回 null。
   *
   * 返回 null 只表示「这个配置没有声明执行节点」，调用方据此退回默认机器或本地 FS。调用方必须先完成
   * 环境属主校验——本端口只把「环境绑定了哪个 Agent 配置」翻译成节点，不回答「调用方能不能用这个配置」。
   */
  getExecutionNode(input: MachineAgentConfigExecutionInput): Promise<MachineAgentConfigNode | null>;

  /** 该组织是否仍有 Agent 配置绑在这台机器上（机器删除前的悬空引用守卫，只回布尔不回行）。 */
  isAgentConfigBoundToMachine(organizationId: string, machineId: string): Promise<boolean>;
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
  if (!getExecutionNode || !isAgentConfigBoundToMachine) {
    throw new Error("MachineAgentConfigPort has not been bound");
  }
  return { getExecutionNode, isAgentConfigBoundToMachine };
}
