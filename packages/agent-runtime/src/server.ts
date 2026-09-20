/**
 * 服务端 Agent Runtime 的公开装配入口（**宿主装配面**）。
 *
 * 与 `./runtime` 分向，两者不可互相替代：
 * - 本入口：宿主向本包注入运行基础能力（`bind*Port`）、装配三条协议路由的工厂、聚合协议 schema
 *   与错误映射。消费方是 `apps/server` 的启动装配层与宿主路由。
 * - `@fenix/agent-runtime/runtime`：本包向外的运行能力面（启动/停止/状态/回收 + 会话与 relay
 *   数据面原语）。消费方是三条链路的编排层。**新消费方一律用 `./runtime`**：1.4 W3b 已把非测试
 *   消费方全部改调 port，原先标 `运行·` 且已无消费方或已随 port 归位的历史导出一并删除
 *（删除清单与逐行判据见 `docs/design/ce-ee-refactoring/review/task-1.4-agent-runtime.md` §14）。
 *
 * 清单形态：**平铺 + 每行行内角色标注**，不按能力切块。原因是本文件由 `biome check --write`
 * 的 organizeImports 全局按 specifier 字母序重排——独立的分组注释会留在原位而语句被移动，
 * 分块注释因此必然说谎。角色写在行内（随语句一起移动），分组由注释前缀表达：
 * **一个模块一条语句**：organizeImports 会把同一 specifier 的多个**同类型性**语句合并成一条
 *（只保留第一条的注释），所以同一模块里混有多类角色时用 `｜` 分区标注、逐名归属，
 * 不能靠拆语句来分标注（`export type` 与 `export` 两族不会被合并，这是唯一可拆的维度）：
 *
 * - `宿主注入·` 宿主实现、包内消费的 port，缺绑定即启动失败；
 * - `宿主取用·` 宿主装配层与宿主路由**直接取用**的包内实现（含作为 `bind*Port` 实现来源的符号）：
 *   不是契约，**不得新增消费方**；宿主侧符号不能「改走 port」——它们正是那些 port 的实现来源，
 *   W6a 按实测把原先误标 `泄漏·` 的这类符号归入此类；
 * - `路由·`／`协议·`／`错误映射·`／`模块配置·` 宿主装配与协议接入面；
 * - `泄漏·` 内部实现泄漏，不属于任何 port（W6 按消费方收敛，**不得新增消费方**）；
 * - `测试取用·` 仅测试消费的实现细节（W6 随测试 seam 移出公开面）。
 *
 * 未收口标注的移除条件：`W6` = 泄漏与测试 seam 收口任务按包删除。
 * `测试取用·` 的判据是「删除即破坏用例」：其中跨包用例（workflow / observer）无法改相对导入，
 * 删行须先给出测试专用入口，属 W6「测试 seam 移出公开面」的裁量范围，本片不预判。
 * `set*Deps` / `reset*` / `_uuid` 一类测试 seam 随所属叶子文件透出，不是公共契约——按
 * `@fenix/resource-observer` 公开入口的既有口径，W6 移出并改由包内用例相对导入。
 *
 * 1.4 W6a 的两处机械收敛（判据与清单见 review §18.4 / §19）：① 按「全仓（含动态 import）无导入者」
 * 删除 40 个零消费名（含 6 个测试 seam 与 2 个仅被包内 index 再出口的符号），删除的契约类型若将来
 * 出现需要命名它的消费方再按需回归——宿主实现 port 靠结构化类型推断，无需具名；② 31 行 `export *`
 * 中 19 行收窄为显式名单（含 §18.4 点名的 `acp-ws-handler` / `external-relay` / `event-bus` 三行，
 * 其余 16 行因含被删名），与 `./server/repositories`、`./server/transport/relay` 的既有口径一致。
 */

export { mapOrchestrationErrorToHttp } from "./errors/orchestration-http"; // 错误映射·编排域错误 → HTTP 的单一真相（宿主 errorPlugin 共用）
export { createAcpRoutes } from "./routes/acp"; // 路由·ACP（守卫/认证/错误日志由宿主注入）
export { createApiInstanceRoutes } from "./routes/api/instances"; // 路由·实例管理
export { createOpenaiChatRoutes } from "./routes/api/openai-chat"; // 路由·OpenAI Chat
export type {
  AcpRouteDependencies,
  AgentRuntimeAuthDependencies,
  ApiInstanceRouteDependencies,
} from "./routes/dependencies"; // 路由·注入契约类型（宿主装配层按它们构造注入对象）
export * from "./schemas/acp.schema"; // 协议·ACP
export type {
  CreateEnvironmentRequest,
  EnterEnvironmentResponse,
  EnvironmentInfo,
  EnvironmentListResponse,
  ListInstancesResponse,
  UpdateEnvironmentRequest,
  UpdateEnvironmentResponse,
} from "./schemas/environment.schema"; // 协议·环境（类型面）
export {
  CreateEnvironmentRequestSchema,
  CreateEnvironmentResponseSchema,
  EnterEnvironmentRequestSchema,
  EnterEnvironmentResponseSchema,
  EnvironmentDetailEnvelopeSchema,
  EnvironmentDetailResponseSchema,
  EnvironmentInfoSchema,
  EnvironmentListEnvelopeSchema,
  EnvironmentListResponseSchema,
  EnvironmentListSchema,
  InstanceSummarySchema,
  ListInstancesResponseSchema,
  UpdateEnvironmentRequestSchema,
  UpdateEnvironmentResponseSchema,
} from "./schemas/environment.schema"; // 协议·环境（schema 值）
export type {
  InstanceActivityInfo as InstanceSchemaActivityInfo,
  InstanceActivityListResponse,
  InstanceInfo as InstanceSchemaInfo,
  InstanceListResponse,
  InstanceStatus,
  SpawnInstanceFromEnvironmentRequest,
  SpawnInstanceFromEnvironmentResponse,
} from "./schemas/instance.schema"; // 协议·实例（与运行态同名类型别名区分）
export {
  InstanceActivityInfoSchema,
  InstanceActivityListResponseSchema,
  InstanceActivityQuerySchema,
  InstanceInfoSchema,
  InstanceListResponseSchema,
  InstanceStatusSchema,
  SpawnInstanceFromEnvironmentRequestSchema,
  SpawnInstanceFromEnvironmentResponseSchema,
} from "./schemas/instance.schema"; // 协议·实例
export type { OpenAIChatCompletionRequest, OpenAIChatCompletionResponse } from "./schemas/openai-chat.schema"; // 协议·OpenAI Chat（类型面）
export {
  OpenAIChatCompletionRequestSchema,
  OpenAIChatCompletionResponseSchema,
  OpenAIErrorResponseSchema,
} from "./schemas/openai-chat.schema"; // 协议·OpenAI Chat（schema 值）
export * from "./server/config"; // 模块配置·本包运行态旋钮的唯一真相（宿主注入）
export {
  type AgentInstanceRecord,
  agentInstanceRepo,
  type CreateAgentInstanceInput,
  type EnvironmentRecord,
  type EnvironmentUpdateParams,
  environmentRepo,
  type IAgentInstanceRepo,
  type IEnvironmentRepo,
  type InstanceCreationSource,
} from "./server/repositories"; // 泄漏·持久化边界（宿主取用；observer 读实例表、workflow 读环境表的观测面随 W6b 收敛）
export * from "./server/repositories/environment-orchestration"; // 泄漏·编排域环境读视图（W6）
export {
  type AgentConfigLookupPort,
  type AgentConfigLookupResult,
  bindAgentConfigLookupPort,
  getAgentConfigLookupPort,
} from "./server/services/agent-config-lookup-port"; // 宿主注入·Agent 配置查询投影
export {
  AgentInstanceService,
  type AutomaticInstanceSelection,
  agentInstanceService,
  bindAgentInstanceRuntimeOperations,
  getAgentInstanceRuntimeOperations,
  resetAgentInstanceRuntimeOperations,
} from "./server/services/agent-instance-service"; // 测试取用·实例生命周期服务（W6：宿主用例改写 resolve/ensure/snapshot）
export {
  type AgentLaunchSpecPort,
  bindAgentLaunchSpecPort,
  getAgentLaunchSpecPort,
  resetAgentLaunchSpecPort,
} from "./server/services/agent-launch-spec-port"; // 宿主注入·启动参数组装
export {
  connectAgentInstance,
  type InstanceOwner,
  setApiInstanceDeps,
} from "./server/services/api-instance"; // 测试取用·程序化 API 实例入口（W6：包内用例取 setApiInstanceDeps/connectAgentInstance）
export * from "./server/services/chat-channel-bootstrap"; // 泄漏·Chat 域装配（W6：observer 取 chat channel 控制器）
export {
  bindCoreRuntimePort,
  type CoreRuntimePort,
  getBoundCoreRuntime,
  getBoundCoreRuntimePort,
  resetCoreRuntimePortForTest,
} from "./server/services/core-runtime-port"; // 宿主注入·Core runtime 与远端节点
export { bindFileWsPort, getFileWsPort } from "./server/services/file-ws-port"; // 宿主注入·file-ws 连接可用性
export {
  bindLocalNodeAgentNodeServicePort,
  getLocalNodeAgentNodeService,
} from "./server/services/local-node-agent-node-service-port"; // 宿主注入·本地节点服务
export {
  bindMachineRegistryPort,
  getMachineRegistryPort,
} from "./server/services/machine-registry-port"; // 宿主注入·机器注册表
export {
  bindRedisConnectionPort,
  getBoundRedisConnection,
  type RedisConnectionProvider,
} from "./server/services/redis-connection-port"; // 宿主注入·Redis 连接
export {
  bindSessionEventBusPort,
  getSessionEventBusPort,
  resetSessionEventBusPort,
} from "./server/services/session-event-bus-port"; // 宿主注入·会话事件总线
export { resolveWorkspacePath } from "./server/services/workspace-resolver"; // 宿主取用·workspace 路径解析（宿主绑给 Machine 的 host port；1.4 W5 后 Machine 已不依赖本包）
export {
  bindAcpInstanceActivityPort,
  closeAcpConnectionsForEnvironments,
  closeAllAcpConnections,
  findMachineConnectionByAgentId,
  findMachineConnectionById,
  handleAcpWsClose,
  handleAcpWsMessage,
  handleAcpWsOpen,
  listAcpConnections,
  recordAcpInstanceActivity,
  resetAcpInstanceActivityPort,
  sendToAgentWs,
  sendToWs,
  setAgentMachineCache,
  triggerMachineCleanupByMachineId,
} from "./server/transport/acp-ws-handler"; // 宿主注入·`bindAcpInstanceActivityPort` 实例活跃度上报（宿主在 main.ts 绑定）｜宿主取用·`findMachineConnectionById` / `triggerMachineCleanupByMachineId` 机器连接索引与清理（Machine host port 的实现来源，本身不是 port）｜泄漏·其余 ACP WS 帧处理与连接索引（W6：observer 读连接表；跨包取用随 W6b 观测面收敛）
export {
  closeAllRelayConnections,
  closeRelayConnectionsForIdleReclaim,
  closeRelayConnectionsForStoppedInstance,
  reclaimInstanceYjsDocs,
  sendToInstanceRelay,
} from "./server/transport/relay"; // 泄漏·前端 relay/YJS 生命周期（W6：与 §1.6 同批）；帧解析（extractJsonRpc/extractAcpEvent）唯一实现在 @fenix/chat-channel，此处不再转出口
export {
  type ExternalRelayConnectionSnapshot,
  type ExternalRelayEnvironment,
  handleExternalRelayClose,
  handleExternalRelayMessage,
  handleExternalRelayOpen,
  listExternalRelayEntries,
  setExternalRelayDeps,
} from "./server/transport/relay/external-relay"; // 泄漏·external-relay 内部状态（W6：observer 读连接快照与条目）
export {
  bindRelayLifecyclePort,
  closeRelayClientsForMachine,
  resetRelayLifecyclePort,
} from "./server/transport/relay/lifecycle-port"; // 宿主注入·relay 生命周期绑定（Chat 装配层调用）
export * from "./services/acp-idle-monitor"; // 测试取用·空闲回收巡检与实例活跃度（W6：用例取 shouldCountInstanceActivity/markInstanceRelayAttached）
export {
  type AgentSession,
  createAgentSession,
  createPromptTurn,
  type OpenAgentSessionResult,
  openAgentSession,
  type PromptTurn,
  type PromptTurnStartOptions,
  setAgentChatServiceDeps,
  startPromptTurn,
} from "./services/agent-chat-service"; // 测试取用·会话与 turn（W6：用例取 createPromptTurn 与两个数据面类型）
export {
  bindEnvironmentAcpLifecyclePort,
  KEBAB_CASE_RE,
  sanitizeResponse,
  validateWorkspacePath,
} from "./services/environment-core"; // 宿主注入·`bindEnvironmentAcpLifecyclePort` 环境 ACP 生命周期绑定｜宿主取用·`sanitizeResponse` 响应脱敏（宿主路由）与 `KEBAB_CASE_RE` / `validateWorkspacePath` 环境名和 workspace 路径校验（宿主用例动态 import）
export * from "./services/instance-registry"; // 测试取用·实例注册表（W6：跨包用例断言并发额度残留）
export * from "./services/orchestration-bootstrap"; // 测试取用·编排域装配（W6：宿主用例复位编排替身）
export {
  type LaunchTargetRef,
  refreshInstanceEnvironment,
  resetOrchestrationInstanceDeps,
  type StopInstancesForEnvironmentsOptions,
  setOrchestrationInstanceDeps,
  spawnInstanceViaController,
  spawnInstanceViaCore,
  stopInstancesForEnvironments,
  stopInstanceViaController,
  terminateLocalDeadInstance,
} from "./services/orchestration-instance"; // 测试取用·实例 spawn/stop 编排（W6：宿主用例注入编排替身）
export {
  createAgentNodeService,
  dispatchAgentNodeDisconnect,
  dispatchAgentNodeWsClose,
  getAgentNodeService,
  wsToAgentNodeSocket,
} from "./transport/agent-node-bridge"; // 宿主取用·`getAgentNodeService` 本地 AgentNode 节点服务（宿主绑给本地节点服务 port）｜泄漏·`createAgentNodeService` 与三个帧原语（W6：无 port 归属）
export {
  EventBus,
  getAcpEventBus,
  getAllEventBuses,
  getEventBus,
  removeAcpEventBus,
  removeEventBus,
} from "./transport/event-bus"; // 泄漏·包内事件总线（宿主取用作会话事件总线 port 的实现来源；workflow 的读取随 W6b 观测面收敛）
export * from "./types/acp-connection"; // 运行态类型·ACP 连接登记项与快照
export * from "./types/auth"; // 运行态类型·鉴权上下文
export * from "./types/environment"; // 运行态类型·环境注册报文
export * from "./types/instance"; // 运行态类型·实例注册表补充字段
export * from "./types/ws-types"; // 运行态类型·WsConnection（使 AcpConnectionEntry["ws"] 派生可在包外解析）
