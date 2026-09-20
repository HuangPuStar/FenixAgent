/**
 * Agent Runtime 的对外运行入口（CE 阶段 2 任务 1.4 / W3）。
 *
 * 与 `./server` 的方向相反：`./server` 是**宿主装配面**（宿主向本包注入运行基础能力：
 * `bind*Port`、路由工厂注入、模块配置），本文件是**本包向外的运行能力面**（其它包与宿主
 * 业务路由消费实例/环境的启动、停止、状态、回收，以及会话与 relay 数据面原语）。
 *
 * 三条契约面：
 * - `AgentRuntimePort`：管理面。回答「实例/环境在不在、怎么起、怎么停、怎么回收」。
 * - `AgentRuntimeSessionApi`：数据面。回答「怎么跑一轮」——relay 连接、ACP session/turn、
 *   定向投递、会话事件总线。数据面原语是 ACP 协议适配层的直接能力，不是业务语义（不解释
 *   actor/role）。`getEventBus` / `removeEventBus` 有创建/释放副作用，故在这一面而不在观测面。
 * - `AgentRuntimeObservability`：只读观测面。回答「现场看得到什么」（W6b 新增）。每个方法都
 *   无副作用，返回当场构造的投影而非包内实体。
 *
 * 设计约束（1.4 裁定）：
 * - 输入只接受已授权的通用参数；Runtime 不查 actor/role/visibility。「启动前取数」（取
 *   agentConfig、组装 LaunchSpec）由 W4 搬到 AgentConfig Facade，经 `AgentInstanceStarter`
 *   由宿主注入，**不在本 port 的输入里**——`ensureInstance` 的输入是「哪个环境的哪个属主要
 *   哪种实例」，不是「拿什么参数起进程」。
 * - 本文件不新增行为：每个方法都是既有包内实现的显式转发。**输入与返回类型一律显式声明**
 *   （1.4 W6b 收敛，判据与逐条清单见 review §20）：此前写 `Awaited<ReturnType<typeof impl>>`
 *   与 `Parameters<typeof impl>[n]`，契约面会随实现签名无声漂移——实现改一个字段，契约跟着改
 *   而不留痕。改显式声明后，实现与契约不一致会在转发处当场编译失败。三个原本没有显式返回类型
 *   的实现（`createWebEnvironment` / `updateWebEnvironment` / `listEnvironmentsWithInstances`）
 *   在此按实测形状定契约；`listEnvironments` 的匿名 join 投影因此有了名字（`EnvironmentListEntry`）。
 * - 实例记录级操作（`getOwnedInstance` / `createInstance` / `stopInstanceRuntime` / …）**直通
 *   `AgentInstanceRecord`**（1.4 W3b 裁定）：控制台要回显实例名/environmentId、编排层要拿记录去
 *   取租约，把记录改成面内的窄视图只会造出第二份投影并在两侧漂移。代价是持久化记录类型出现在
 *   契约面上——这是**有意保留**的取舍，不是待收敛项：同一理由适用于 `EnvironmentRecord`
 *   （W6b 起由本文件显式导出）。
 * - 包外对包内状态的取数已按消费方收敛（W6b）：observer 的连接表与环境/实例回读取 `observe`，
 *   workflow 的事件总线取 `session`，环境记录读视图取 `observe`。`./server` 上仍保留的是
 *   **宿主装配面**（`bind*Port` 的实现来源、路由工厂、协议 schema）——宿主的取用不改走 port，
 *   因为它正是那些 port 的提供方（判据见 review §19.2-3）。
 */

import type { EngineRelayHandle } from "@fenix/plugin-sdk";
import type { AgentInstanceRecord } from "./server/repositories/agent-instance";
import { agentInstanceRepo } from "./server/repositories/agent-instance";
import type { EnvironmentRecord } from "./server/repositories/environment";
import { environmentRepo } from "./server/repositories/environment";
import type {
  RuntimeSnapshot,
  RuntimeState,
  RuntimeStopMode,
} from "./server/services/agent-instance-runtime-coordinator";
import type { InstanceActivityInfo, SpawnedInstance } from "./server/services/agent-instance-runtime-projection";
import {
  findRunningInstanceByEnvironment,
  getInstance,
  listInstances as listRuntimeInstances,
  stopInstance,
} from "./server/services/agent-instance-runtime-projection";
import type { AutomaticInstanceSelection } from "./server/services/agent-instance-service";
import { agentInstanceService, bindAgentInstanceRuntimeOperations } from "./server/services/agent-instance-service";
import {
  createWebEnvironment,
  listEnvironmentsWithInstances,
  updateWebEnvironment,
} from "./server/services/environment-web";
import {
  closeAcpConnectionsForEnvironments,
  closeAllAcpConnections,
  listAcpConnections as listAcpConnectionSnapshots,
  sendToAgentWs,
} from "./server/transport/acp-ws-handler";
import { connectAgentRelay } from "./server/transport/agent-relay";
import { closeAllRelayConnections } from "./server/transport/relay";
import type { ExternalRelayConnectionSnapshot } from "./server/transport/relay/external-relay";
import { listExternalRelayEntries } from "./server/transport/relay/external-relay";
import { sendToInstanceRelay } from "./server/transport/relay/relay-handler";
import {
  listInstanceActivitySnapshotsWithUsers,
  markInstanceRelayAttached,
  markInstanceRelayDetached,
  startAcpIdleMonitor,
  stopAcpIdleMonitor,
  touchInstanceActivity,
} from "./services/acp-idle-monitor";
import type {
  AgentSession,
  OpenAgentSessionInput,
  OpenAgentSessionResult,
  PromptTurn,
  PromptTurnStartOptions,
} from "./services/agent-chat-service";
import { createAgentSession, createPromptTurn, openAgentSession, startPromptTurn } from "./services/agent-chat-service";
import { getEnvironmentBySecret } from "./services/environment-acp";
import type {
  CreateWebEnvironmentParams,
  EnvironmentRole,
  UpdateWebEnvironmentParams,
} from "./services/environment-core";
import { deleteEnvironment, getOwnedEnvironment } from "./services/environment-core";
import { convergeMachineInstances } from "./services/machine-instance-cleanup";
import { getOrchestrationController } from "./services/orchestration-bootstrap";
import type { StopInstancesForEnvironmentsOptions } from "./services/orchestration-instance";
import {
  refreshInstanceEnvironment,
  spawnInstanceViaController,
  stopInstancesForEnvironments,
  stopInstanceViaController,
  terminateLocalDeadInstance,
} from "./services/orchestration-instance";
import { getSession, resolveExistingSessionId, updateSessionStatus } from "./services/session";
import type { EventBus } from "./transport/event-bus";
import { getEventBus, removeEventBus } from "./transport/event-bus";
import type { AcpConnectionSnapshot } from "./types/acp-connection";

// ─────────────────────────────────────────────────────────────────────────────
// 契约类型（1.4 W6b：显式声明，不派生自实现；理由见文件头「设计约束」）
//
// 下方每个匿名形状都**取自实现的实测返回构造**，不是凭空定义；差别只在「谁定义语义」——
// 显式声明后契约面自持，实现漂移会被转发处的赋值检查挡住，而不是把契约一起带走。
// 字段的可空性、是否 `readonly` 以本文件为准，实现侧以可变对象满足（TS 允许该项赋值）。
// ─────────────────────────────────────────────────────────────────────────────

/** 环境列表项：控制台列表投影。字段名保持 API 的 snake_case——它直接进响应体，不在这里改名。 */
export interface EnvironmentListEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly workspace_path: string;
  readonly agent_config_id: string | null;
  readonly agent_name: string | null;
  readonly status: string;
  readonly machine_name: string | null;
  readonly branch: string | null;
  readonly auto_start: boolean;
  readonly last_poll_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  /** 默认实例 uid（无实例时为 null），列表行的「进入」入口用。 */
  readonly instance_uid: string | null;
  /** 内嵌实例摘要。用可变数组：它整体进 Elysia 响应 schema 校验，只读数组与 schema 推断不兼容。 */
  readonly instances: EnvironmentInstanceSummary[];
  readonly instances_count: number;
}

/** 环境列表项内嵌的实例摘要。 */
export interface EnvironmentInstanceSummary {
  readonly instanceUid: string;
  readonly name: string;
  /** 取 `RuntimeState` 而非 `string`：该字段进 `InstanceSummarySchema` 的五值枚举校验，放宽会静默丢校验。 */
  readonly status: RuntimeState;
  readonly createdAt: string;
}

/**
 * 按 Environment Secret 反查环境的鉴权投影（认证路径用）。
 *
 * 只含鉴权所需字段，各字段可空性与环境记录一致：机器上报的环境可能没有属主或组织。
 */
export interface EnvironmentSecretLookup {
  readonly id: string;
  readonly userId: string | null;
  readonly agentConfigId: string | null;
  readonly organizationId: string | null;
  readonly secret: string;
}

/** 停止实例的结果。`ok: false` 时 `error` 给出可对外展示的原因。 */
export interface StopInstanceOutcome {
  readonly ok: boolean;
  readonly error?: string;
}

/** `startPromptTurn` 的结果：本轮 turn 与它所在的会话。 */
export interface PromptTurnStartResult {
  readonly turn: PromptTurn;
  readonly session: AgentSession;
}

/**
 * `createAgentSession` 的输入。
 *
 * `stopInstance` 是可选的所有权回调：请求类会话（api / workflow）复用持久实例，dispose 只能
 * 释放请求资源，不传即只关 relay handle（见 CLAUDE.md「请求/session 不拥有共享 runtime 生命周期」）。
 */
export interface CreateAgentSessionInput {
  readonly relayHandle: EngineRelayHandle;
  readonly instanceId: string;
  readonly stopInstance?: () => Promise<void>;
}

/**
 * RCS 会话记录的读视图。
 *
 * 定名取代实现内的私有 `LightweightSession`——那个名字描述的是「比完整会话少几个字段」这一
 * 实现事实，而契约面只应回答「读会话记录得到什么」。
 */
export interface SessionRecord {
  readonly id: string;
  readonly status: string;
}

/**
 * chat-relay 客户端连接快照（**只读投影**）。
 *
 * 字段集是 observer 观察链路的消费面，不是 `@fenix/chat-channel` 的 `ClientConnection` 全量——
 * 直接把那个类型经本入口透出会把 chat 域的内部类型钉进本包契约，且带出它的加载图。这里的
 * 取向与「不把 `ChatChannelController` 本体或 `ConnectionRegistry` 透出」一致：观察方拿快照。
 * 字段随消费面收窄/扩张时，投影构造处会编译失败而不是静默丢字段。
 */
export interface ChatClientConnectionSnapshot {
  readonly wsId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly instanceId: string;
  readonly rcsSessionId: string;
  /** 已协商的 ACP session ID；尚未建立时为 null。 */
  readonly acpSessionId: string | null;
  /** 连接建立时间（毫秒时间戳）。 */
  readonly openTime: number;
}

/** `ensureInstance` 的输入：已授权的实例归属与选择方式（见文件头：不含启动参数）。 */
export interface EnsureInstanceInput {
  readonly environmentId: string;
  /** 实例属主；必须与环境属主一致，由调用方保证（Runtime 不解释 actor）。 */
  readonly ownerUserId: string;
  /** 指定实例时必须属于该属主且属于该环境，否则按未找到处理。 */
  readonly requestedInstanceUid?: string;
  /** 未指定实例时的自动选择类别（chat / api / workflow 各自的持久实例）。 */
  readonly automaticSelection: AutomaticInstanceSelection;
  /** 取消信号：启动过程中断时不再继续（实例记录已存在时保持既有语义）。 */
  readonly signal?: AbortSignal;
}

/** `createInstance` 的输入：新建一个非默认的持久实例（不启动 runtime，启动走 `ensureInstanceRuntime`）。 */
export interface CreateInstanceInput {
  readonly environmentId: string;
  /** 实例属主；必须与环境属主一致，由调用方保证（Runtime 不解释 actor）。 */
  readonly ownerUserId: string;
  /** 记录创建者（审计列）；交互式控制台里与属主相同。 */
  readonly actorUserId: string;
  /** 实例名，须唯一可读；空串、超过 100 字符或保留名 `default` 会被实现拒绝（400）。 */
  readonly name: string;
}

/**
 * 管理面：实例与环境的生命周期。
 *
 * 四组语义：启动（实例/环境的创建与运行保证）、停止、状态（查询与活跃度标记）、回收
 * （空闲清理、机器下线清理、进程退出）。
 */
export interface AgentRuntimePort {
  // ── 启动 ──

  /** 确保指定环境下属主的实例存在且已启动，返回该实例记录（`resolveInstanceForOperation` + `ensureInstanceRuntime`）。 */
  ensureInstance(input: EnsureInstanceInput): Promise<AgentInstanceRecord>;
  /** 启动一个已存在的实例记录（幂等：目标状态已达成时直接返回）。 */
  ensureInstanceRuntime(instance: AgentInstanceRecord, signal?: AbortSignal): Promise<void>;
  /** 查找或创建环境的下属主默认实例（`chat` 类，名 `default`），不启动 runtime。 */
  findOrCreateDefaultInstance(environmentId: string, ownerUserId: string): Promise<AgentInstanceRecord>;
  /**
   * 查找或创建环境的下属主 workflow 持久实例（名 `primary`），并回报本次是否新建。
   *
   * `created` 是编排层的所有权判据：只有自己创建的实例才由自己负责停止，复用别人已启动的实例
   * 不能顺手停掉（见 workflow 的实例清理路径）。
   */
  findOrCreateWorkflowInstanceWithStatus(
    environmentId: string,
    ownerUserId: string,
  ): Promise<{ instance: AgentInstanceRecord; created: boolean }>;
  /** 新建持久实例记录（`creationSource: "user"`）；不做环境归属校验，调用方先查环境。 */
  createInstance(input: CreateInstanceInput): Promise<AgentInstanceRecord>;
  /** 创建 Web 环境（含默认实例的启动编排）。 */
  createEnvironment(params: CreateWebEnvironmentParams): Promise<EnvironmentRecord>;
  /** 更新环境配置；是否重启实例由实现按需决定。 */
  updateEnvironment(
    environmentId: string,
    organizationId: string,
    params: UpdateWebEnvironmentParams,
  ): Promise<EnvironmentRecord>;
  /** 重启指定环境下处于运行/启动中的实例，返回被重启的实例 ID。 */
  restartActiveInstancesForEnvironments(environmentIds: string[]): Promise<string[]>;
  /** 打开一次程序化 Agent 会话（`api/primary` 类持久实例 + 独立 relay/ACP session）。 */
  openAgentSession(input: OpenAgentSessionInput): Promise<OpenAgentSessionResult>;

  // ── 停止 ──

  /** 停止单个实例（含组织归属校验；幂等，目标状态已达成时返回成功）。 */
  stopInstance(instanceUid: string, organizationId: string): Promise<StopInstanceOutcome>;
  /** 停止实例 runtime，保留实例记录（`mode: "strict"` 下停止失败即抛错）。 */
  stopInstanceRuntime(instance: AgentInstanceRecord, mode?: RuntimeStopMode): Promise<void>;
  /** 用同一实例 uid 重启 runtime（记录不变；默认实例同样支持）。 */
  restartInstanceRuntime(instance: AgentInstanceRecord): Promise<void>;
  /** 停止 runtime 并删除实例记录；默认实例被拒（`DEFAULT_INSTANCE_DELETE_DENIED` 409）。 */
  deleteInstance(instance: AgentInstanceRecord): Promise<void>;
  /** 停止指定环境下的全部实例，返回被停止的实例 ID。 */
  stopInstancesForEnvironments(
    environmentIds: string[],
    options?: StopInstancesForEnvironmentsOptions,
  ): Promise<string[]>;
  /** 删除环境。 */
  deleteEnvironment(environmentId: string): Promise<boolean>;
  /** 关闭指定环境的 ACP 连接（relay 连接另行关闭）。 */
  closeAcpConnectionsForEnvironments(environmentIds: string[]): void;
  /** 关闭全部 ACP 连接（进程退出路径）。 */
  closeAllAcpConnections(): void;
  /** 关闭全部前端 relay/YJS 连接（进程退出路径）。 */
  closeAllRelayConnections(): void;

  // ── 状态 ──

  /** 读环境并做归属校验（组织 + 可选用户/角色）；不满足时按权限语义抛错。 */
  getOwnedEnvironment(
    environmentId: string,
    organizationId: string,
    userId?: string,
    role?: EnvironmentRole,
  ): Promise<EnvironmentRecord>;
  /** 列出组织下环境及其实例计数/agent 名（控制台列表）。 */
  listEnvironments(organizationId: string, viewerUserId?: string): Promise<EnvironmentListEntry[]>;
  /** 按 Environment Secret 查环境（机器/节点上报路径）。 */
  getEnvironmentBySecret(secret: string): Promise<EnvironmentSecretLookup | null>;
  /** 按环境找运行中的实例（多实例场景返回其一）。 */
  findRunningInstanceByEnvironment(environmentId: string, userId?: string): SpawnedInstance | undefined;
  /** 按组织列出内存运行态实例。 */
  listRuntimeInstances(organizationId: string): SpawnedInstance[];
  /** 按实例 ID 读内存运行态实例（带可选归属校验）。 */
  getRuntimeInstance(instanceUid: string, userId?: string): SpawnedInstance | undefined;
  /** 按属主读单个持久实例记录；不属于该属主（或 uid 非法）按未找到处理。 */
  getOwnedInstance(instanceUid: string, ownerUserId: string): Promise<AgentInstanceRecord>;
  /** 按属主列出持久实例记录及其运行态快照。 */
  listOwnedInstances(
    ownerUserId: string,
    environmentId?: string,
  ): Promise<Array<AgentInstanceRecord & { runtime: RuntimeSnapshot }>>;
  /** 读持久实例的运行态快照（状态机 + generation + 最近失败）。 */
  getRuntimeSnapshot(instanceUid: string): RuntimeSnapshot;
  /** 列出实例活跃度投影（含用户、spawn 来源、idle/activity 判定），供控制台与回收巡检使用。 */
  listInstanceActivity(now?: number, organizationId?: string, showError?: boolean): Promise<InstanceActivityInfo[]>;
  /** 记录一次 ACP 业务消息带来的活跃度时间戳。 */
  touchInstanceActivity(instanceId: string, message: Record<string, unknown>, at?: number): void;
  /** 标记前端 relay 已挂到实例（引用计数）。 */
  markInstanceRelayAttached(instanceId: string, at?: number): void;
  /** 标记前端 relay 已从实例断开。 */
  markInstanceRelayDetached(instanceId: string, at?: number): void;
  /** 刷新实例的 workspace 配置与 Skills（复用运行实例新建 ACP session 前调用）。 */
  refreshInstanceEnvironment(instanceId: string, environmentId: string, userId: string): Promise<void>;
  /** 读 RCS 会话记录。 */
  getSession(sessionId: string): Promise<SessionRecord | null>;
  /** 从 ACP session ID 反解已存在的 RCS 会话 ID。 */
  resolveExistingSessionId(sessionId: string): Promise<string | null>;
  /** 更新会话状态（active / archived 等）。 */
  updateSessionStatus(sessionId: string, status: string): void;

  // ── 回收 ──

  /**
   * 机器下线 / 重连 / 退役时收敛其上的全部实例：删除 Core runtime 实例、配对注销实例登记表，
   * 再清理编排域活跃表与节点引用，返回从 Core runtime 删除的实例数。
   *
   * 「删 Core 实例」与「注销登记表」是一个不可分的动作（漏掉后者会让幽灵实例永久计入并发额度、
   * `hasActiveInstance` 误判存活），因此合并为一个方法：调用方拿不到中间态，也就没机会漏配对。
   * 沙盒释放等不经 ACP handler 的路径同样走这里（E-P0.1）。
   */
  cleanupMachineInstances(machineId: string): number;
  /** 回收确认已死亡的本地实例（异步；不阻塞调用方消息循环）。 */
  terminateLocalDeadInstance(instanceId: string): Promise<void>;
  /** 启动 ACP 空闲回收巡检。 */
  startIdleMonitor(): void;
  /** 停止 ACP 空闲回收巡检。 */
  stopIdleMonitor(): void;
  /** 进程退出：停止全部实例 runtime 并释放编排资源。 */
  shutdown(): Promise<void>;
}

/**
 * 数据面：会话与 relay 原语。
 *
 * 这些是 ACP 协议适配层的直接能力，业务编排（三条链路）各自组合它们；port 不替调用方
 * 做 session/turn 生命周期决策（`release` vs `dispose` 的语义差异见各实现注释）。
 */
export interface AgentRuntimeSessionApi {
  /** 建立到实例的 relay 连接（共享 relay handle；同一 instanceId 的调用方共享连接）。 */
  connectRelay(instanceId: string, sessionId: string): Promise<EngineRelayHandle>;
  /** 由 relay handle 构造 AgentSession（`dispose` 会关闭 relay handle）。 */
  createAgentSession(config: CreateAgentSessionInput): AgentSession;
  /** 构造 PromptTurn（同一 ACP session 可多轮）。 */
  createPromptTurn(session: AgentSession, sessionId: string): PromptTurn;
  /** 新建或恢复 ACP session 并开始一轮 prompt。 */
  startPromptTurn(options: PromptTurnStartOptions): Promise<PromptTurnStartResult>;
  /** 向实例所在机器的 ACP 连接定向投递消息。 */
  sendToAgentWs(agentId: string, message: object): boolean;
  /** 向实例的 remote relay 定向投递消息。 */
  sendToInstanceRelay(instanceId: string, data: string): boolean;
  /**
   * 取（必要时创建）按会话 ID 索引的进程内事件总线。
   *
   * **有副作用**（首次调用创建总线），故属数据面而非 `observe`：workflow 用它给每个 workflow 开
   * 一条 SSE 总线。消费方必须配对调用 {@link removeEventBus}，否则总线与订阅者常驻。
   */
  getEventBus(sessionId: string): EventBus;
  /** 释放会话事件总线；不存在的 key 不抛错（幂等）。 */
  removeEventBus(sessionId: string): void;
}

/**
 * 只读观测面：观察链路读的运行时投影。
 *
 * 供 observer 一类**只读**消费方现场采集状态，也承接只想读运行数据、不想持仓储的消费方
 *（workflow / meta-agent 的环境候选读视图）。每个方法都无副作用、不改变任何登记表，返回的是
 * 当场构造的投影而不是包内实体——消费方拿到的是「看得到什么」，不是「能操作什么」。
 * 需要创建/释放总线的能力在 `session`（见该接口对 `getEventBus` 的说明）。
 */
export interface AgentRuntimeObservability {
  /** ACP（机器接入）连接登记表快照。 */
  listAcpConnections(): readonly AcpConnectionSnapshot[];
  /** 外部 relay 连接登记表快照。 */
  listExternalRelayConnections(): readonly ExternalRelayConnectionSnapshot[];
  /**
   * chat-relay 客户端连接快照（由 Chat 域连接登记表现造）。
   *
   * 异步且**必须在方法内动态 import** `chat-channel-bootstrap`：它静态拖入 ioredis / yjs，
   * 静态导入会让本包所有消费方（含只跑替身的用例）都在加载期付这份代价。
   */
  listChatClients(): Promise<ChatClientConnectionSnapshot[]>;
  /** 持久实例名称（观测输出的展示名）；未知实例返回 undefined。 */
  getInstanceName(instanceUid: string): Promise<string | undefined>;
  /** 按 ID 读环境记录（观察链路的权威回查）；不存在返回 undefined（沿用仓储的「未找到」惯用法）。 */
  getEnvironmentRecord(environmentId: string): Promise<EnvironmentRecord | undefined>;
  /** 列出组织下的环境记录（workflow / meta-agent 的环境候选读视图）。 */
  listEnvironmentRecordsByOrganization(organizationId: string): Promise<EnvironmentRecord[]>;
}

/** 本包的对外运行入口：管理面在顶层，数据面在 `session`，只读观测面在 `observe`。 */
export interface AgentRuntime extends AgentRuntimePort {
  readonly session: AgentRuntimeSessionApi;
  readonly observe: AgentRuntimeObservability;
}

/**
 * Runtime 模块的运行时表面（`fenix.module.ts` 的 `create` 目标）。
 *
 * 只暴露需要「对象身份」的能力：实例与环境的生命周期是本包唯一持有进程级可变状态的职责面，
 * 再构造一套等于给同一批实例开两条回收路径。因此组合根返回包内既有单例的入口。
 */
export interface AgentRuntimeModule {
  readonly id: "agent-runtime";
  readonly runtime: AgentRuntime;
}

/**
 * 构造运行入口。
 *
 * 每次调用返回新的对象，但内部持有的都是本包的模块级单例（`agentInstanceService`、
 * `globalInstanceRegistry`、relay 连接表），因此多次构造不会产生第二套运行状态——与
 * `AgentInstanceRuntimeCoordinator` 的装配语义一致。
 */
export function createAgentRuntime(): AgentRuntime {
  const port: AgentRuntimePort = {
    async ensureInstance(input) {
      const instance = await agentInstanceService.resolveInstanceForOperation({
        environmentId: input.environmentId,
        ownerUserId: input.ownerUserId,
        requestedInstanceUid: input.requestedInstanceUid,
        automaticSelection: input.automaticSelection,
      });
      await agentInstanceService.ensureInstanceRuntime(instance, input.signal);
      return instance;
    },
    ensureInstanceRuntime: (instance, signal) => agentInstanceService.ensureInstanceRuntime(instance, signal),
    findOrCreateDefaultInstance: (environmentId, ownerUserId) =>
      agentInstanceService.findOrCreateDefaultInstance(environmentId, ownerUserId),
    findOrCreateWorkflowInstanceWithStatus: (environmentId, ownerUserId) =>
      agentInstanceService.findOrCreateWorkflowInstanceWithStatus(environmentId, ownerUserId),
    createInstance: (input) => agentInstanceService.createUserInstance(input),
    createEnvironment: (params) => createWebEnvironment(params),
    updateEnvironment: (environmentId, organizationId, params) =>
      updateWebEnvironment(environmentId, organizationId, params),
    restartActiveInstancesForEnvironments: (environmentIds) =>
      agentInstanceService.restartActiveInstancesForEnvironments(environmentIds),
    openAgentSession: (input) => openAgentSession(input),

    stopInstance: (instanceUid, organizationId) => stopInstance(instanceUid, organizationId),
    stopInstanceRuntime: (instance, mode) => agentInstanceService.stopInstanceRuntime(instance, mode),
    restartInstanceRuntime: (instance) => agentInstanceService.restartInstanceRuntime(instance),
    deleteInstance: (instance) => agentInstanceService.deleteInstance(instance),
    stopInstancesForEnvironments: (environmentIds, options) => stopInstancesForEnvironments(environmentIds, options),
    deleteEnvironment: (environmentId) => deleteEnvironment(environmentId),
    closeAcpConnectionsForEnvironments: (environmentIds) => closeAcpConnectionsForEnvironments(environmentIds),
    closeAllAcpConnections: () => closeAllAcpConnections(),
    closeAllRelayConnections: () => closeAllRelayConnections(),

    getOwnedEnvironment: (environmentId, organizationId, userId, role) =>
      getOwnedEnvironment(environmentId, organizationId, userId, role),
    listEnvironments: (organizationId, viewerUserId) => listEnvironmentsWithInstances(organizationId, viewerUserId),
    getEnvironmentBySecret: (secret) => getEnvironmentBySecret(secret),
    findRunningInstanceByEnvironment: (environmentId, userId) =>
      findRunningInstanceByEnvironment(environmentId, userId),
    listRuntimeInstances: (organizationId) => listRuntimeInstances(organizationId),
    getRuntimeInstance: (instanceUid, userId) => getInstance(instanceUid, userId),
    getOwnedInstance: (instanceUid, ownerUserId) => agentInstanceService.getOwnedInstance(instanceUid, ownerUserId),
    listOwnedInstances: (ownerUserId, environmentId) => agentInstanceService.listInstances(ownerUserId, environmentId),
    getRuntimeSnapshot: (instanceUid) => agentInstanceService.getRuntimeSnapshot(instanceUid),
    listInstanceActivity: (now, organizationId, showError) =>
      listInstanceActivitySnapshotsWithUsers(now, organizationId, showError),
    touchInstanceActivity: (instanceId, message, at) => touchInstanceActivity(instanceId, message, at),
    markInstanceRelayAttached: (instanceId, at) => markInstanceRelayAttached(instanceId, at),
    markInstanceRelayDetached: (instanceId, at) => markInstanceRelayDetached(instanceId, at),
    refreshInstanceEnvironment: (instanceId, environmentId, userId) =>
      refreshInstanceEnvironment(instanceId, environmentId, userId),
    getSession: (sessionId) => getSession(sessionId),
    resolveExistingSessionId: (sessionId) => resolveExistingSessionId(sessionId),
    updateSessionStatus: (sessionId, status) => updateSessionStatus(sessionId, status),

    cleanupMachineInstances: (machineId) => convergeMachineInstances(machineId),
    terminateLocalDeadInstance: (instanceId) => terminateLocalDeadInstance(instanceId),
    startIdleMonitor: () => startAcpIdleMonitor(),
    stopIdleMonitor: () => stopAcpIdleMonitor(),
    shutdown: () => agentInstanceService.shutdownRuntimes(),
  };

  return {
    ...port,
    session: {
      connectRelay: (instanceId, sessionId) => connectAgentRelay(instanceId, sessionId),
      createAgentSession: (config) => createAgentSession(config),
      createPromptTurn: (session, sessionId) => createPromptTurn(session, sessionId),
      startPromptTurn: (options) => startPromptTurn(options),
      sendToAgentWs: (agentId, message) => sendToAgentWs(agentId, message),
      sendToInstanceRelay: (instanceId, data) => sendToInstanceRelay(instanceId, data),
      getEventBus: (sessionId) => getEventBus(sessionId),
      removeEventBus: (sessionId) => removeEventBus(sessionId),
    },
    observe: {
      listAcpConnections: () => listAcpConnectionSnapshots(),
      listExternalRelayConnections: () => listExternalRelayEntries(),
      listChatClients: async () => {
        // 动态 import 的理由见 `AgentRuntimeObservability.listChatClients` 的注释。
        const { getChatChannelController } = await import("./server/services/chat-channel-bootstrap");
        const out: ChatClientConnectionSnapshot[] = [];
        getChatChannelController().registry.forEachClientEntry((wsId, client) => {
          out.push({
            wsId,
            userId: client.userId,
            agentId: client.agentId,
            instanceId: client.instanceId,
            rcsSessionId: client.rcsSessionId,
            acpSessionId: client.acpSessionId,
            openTime: client.openTime,
          });
        });
        return out;
      },
      getInstanceName: async (instanceUid) => (await agentInstanceRepo.getById(instanceUid))?.name,
      getEnvironmentRecord: (environmentId) => environmentRepo.getById(environmentId),
      listEnvironmentRecordsByOrganization: (organizationId) => environmentRepo.listByOrganizationId(organizationId),
    },
  };
}

let boundRuntime: AgentRuntime | null = null;

/**
 * 创建 Runtime 模块实例。
 *
 * 幂等：内部持有的都是模块级单例，重复调用返回同一入口，不产生第二份运行状态（与
 * `createMachineModule` / `createSandboxModule` 同口径）。首次创建时完成 `bindAgentRuntime`，
 * 使 `getBoundAgentRuntime()` 可作为「宿主装配已完成」的判据——装配未走到 Runtime 时，
 * 消费方拿到的是明确的「未绑定」失败，而不是一个依赖尚未就绪的入口。
 *
 * 同时在本组合根绑定实例生命周期所需的编排操作（`AgentInstanceRuntimeOperations`，§4.6）：
 * 那是本包的内部装配 seam，不是对外 port——此前由宿主把包自己导出的
 * `spawnInstanceViaController` / `stopInstanceViaController` 再转发回来绑定，宿主只是中间人。
 * 放在这里之后，宿主只表达「装配 Runtime 模块」，不再复述本包的内部接线。
 */
export function createAgentRuntimeModule(): AgentRuntimeModule {
  if (!boundRuntime) {
    boundRuntime = createAgentRuntime();
    // 只在首次装配时绑定：重复调用不得覆盖用例或宿主后置绑定的替身（同 `bind*Port` 的一次装配语义）。
    bindAgentInstanceRuntimeOperations({
      spawnInstance: spawnInstanceViaController,
      stopInstance: stopInstanceViaController,
      hasActiveInstance: (instanceUid) =>
        getOrchestrationController()
          .listInstances()
          .some((instance) => instance.instanceId === instanceUid),
    });
  }
  return { id: "agent-runtime", runtime: boundRuntime };
}

/**
 * 宿主在装配阶段绑定运行入口（与 `bind*Port` 同口径：一次装配，全局共享）。
 *
 * 重复绑定不同实例会抛错——两套运行入口意味着两套绑定状态，排查时无法区分是哪一个在生效。
 */
export function bindAgentRuntime(runtime: AgentRuntime): void {
  if (boundRuntime && boundRuntime !== runtime) {
    throw new Error("AgentRuntime has already been bound");
  }
  boundRuntime = runtime;
}

/**
 * 取已装配的运行入口。
 *
 * 未装配即失败，不隐式回退为「现场构造一个」——隐式构造会让消费方在宿主尚未完成装配
 * （例如模块配置、宿主 port 未就绪）时拿到一个看似可用、实际会在调用中途失败的入口。
 */
export function getBoundAgentRuntime(): AgentRuntime {
  if (!boundRuntime) throw new Error("AgentRuntime has not been bound");
  return boundRuntime;
}

/** 测试用：解绑，防止测试进程内的装配状态泄漏。 */
export function resetAgentRuntimeForTest(): void {
  boundRuntime = null;
}

// 本文件内已声明的契约类型（`Environment*` / `PromptTurnStartResult` / `SessionRecord` 等）随
// 其声明处直接导出，不在这里重复列——重复会构成重复导出（TS2484）。此处只列来自实现的类型。
export type {
  AcpConnectionSnapshot,
  AgentInstanceRecord,
  AgentSession,
  AutomaticInstanceSelection,
  CreateWebEnvironmentParams,
  EngineRelayHandle,
  EnvironmentRecord,
  EventBus,
  ExternalRelayConnectionSnapshot,
  InstanceActivityInfo,
  OpenAgentSessionInput,
  OpenAgentSessionResult,
  PromptTurn,
  PromptTurnStartOptions,
  RuntimeSnapshot,
  RuntimeStopMode,
  SpawnedInstance,
  UpdateWebEnvironmentParams,
};
