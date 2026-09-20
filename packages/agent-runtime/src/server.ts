/**
 * 服务端 Agent Runtime 的公开装配入口（**宿主装配面**）。
 *
 * 与 `./runtime` 分向，两者不可互相替代：
 * - 本入口：宿主向本包注入运行基础能力（`bind*Port`）、装配三条协议路由的工厂、聚合协议 schema
 *   与错误映射。消费方是 `apps/server` 的启动装配层与宿主路由。
 * - `@fenix/agent-runtime/runtime`：本包向外的运行能力面（启动/停止/状态/回收 + 会话与 relay
 *   数据面原语）。消费方是三条链路的编排层。任务 1.4 W3 起新增，**新消费方一律用 `./runtime`**；
 *   标 `运行·` 的行是尚未迁走的历史导出，W3b 按 port 归位后删除。
 *
 * 清单形态：**平铺 + 每行行内角色标注**，不按能力切块。原因是本文件由 `biome check --write`
 * 的 organizeImports 全局按 specifier 字母序重排——独立的分组注释会留在原位而语句被移动，
 * 分块注释因此必然说谎。角色写在行内（随语句一起移动），分组由注释前缀表达：
 *
 * - `宿主注入·` 宿主实现、包内消费的 port，缺绑定即启动失败；
 * - `路由·`／`协议·`／`错误映射·`／`模块配置·` 宿主装配与协议接入面；
 * - `运行·` 实例/环境生命周期与会话数据面（W3b 迁到 `./runtime`）；
 * - `泄漏·` 内部实现泄漏，不属于任何 port（W6 按消费方收敛，**不得新增消费方**）。
 *
 * 两处未收口标注的移除条件：`W3b` = 迁到 `./runtime` 后删除；`W6` = 泄漏收口任务按包删除。
 * `set*Deps` / `reset*` / `_uuid` 一类测试 seam 随所属叶子文件透出，不是公共契约——按
 * `@fenix/resource-observer` 公开入口的既有口径，W6 移出并改由包内用例相对导入。
 */

export * from "./errors/orchestration-http"; // 错误映射·编排域错误 → HTTP 的单一真相（宿主 errorPlugin 共用）
export { createAcpRoutes } from "./routes/acp"; // 路由·ACP（守卫/认证/错误日志由宿主注入）
export { createApiInstanceRoutes } from "./routes/api/instances"; // 路由·实例管理
export { createOpenaiChatRoutes } from "./routes/api/openai-chat"; // 路由·OpenAI Chat
export type {
  AcpRouteDependencies,
  AgentRuntimeAuthDependencies,
  ApiInstanceRouteDependencies,
  RequestErrorLogger,
} from "./routes/dependencies"; // 路由·注入契约类型（宿主装配层按它们构造注入对象）
export * from "./schemas/acp.schema"; // 协议·ACP
export * from "./schemas/environment.schema"; // 协议·环境
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
export * from "./schemas/openai-chat.schema"; // 协议·OpenAI Chat
export * from "./server/config"; // 模块配置·本包运行态旋钮的唯一真相（宿主注入）
export * from "./server/instance/agent-instance-id"; // 运行·实例 ID 生成与校验（W3b）
export {
  type AgentInstanceRecord,
  agentInstanceRepo,
  type CreateAgentInstanceInput,
  type EnvironmentCreateParams,
  type EnvironmentRecord,
  type EnvironmentUpdateParams,
  environmentRepo,
  type IAgentInstanceRepo,
  type IEnvironmentRepo,
  type InstanceCreationSource,
} from "./server/repositories"; // 泄漏·持久化边界（W6：observer/workflow/machine 直接吃 repo）
export * from "./server/repositories/environment-orchestration"; // 泄漏·编排域环境读视图（W6）
export * from "./server/services/agent-instance-runtime-coordinator"; // 运行·实例 runtime 状态机（W3b）
export * from "./server/services/agent-instance-runtime-projection"; // 运行·实例运行态投影（W3b）
export * from "./server/services/agent-instance-service"; // 运行·实例生命周期服务（W3b）
export * from "./server/services/api-instance"; // 运行·程序化 API 实例入口（W3b）
export * from "./server/services/chat-channel-bootstrap"; // 运行·Chat 域装配（W3b）
export * from "./server/services/core-runtime-port"; // 宿主注入·Core runtime 与远端节点
export * from "./server/services/environment-web"; // 运行·环境控制台读写（W3b）
export * from "./server/services/file-ws-port"; // 宿主注入·file-ws 连接可用性
export * from "./server/services/local-node-agent-node-service-port"; // 宿主注入·本地节点服务
export * from "./server/services/machine-registry-port"; // 宿主注入·机器注册表
export * from "./server/services/redis-connection-port"; // 宿主注入·Redis 连接
export * from "./server/services/session-event-bus-port"; // 宿主注入·会话事件总线
export { resolveWorkspacePath } from "./server/services/workspace-resolver"; // 泄漏·workspace 路径（W6：machine 直接依赖）
export * from "./server/transport/acp-ws-handler"; // 运行·ACP WS 帧处理与连接索引（W3b）
export * from "./server/transport/agent-relay"; // 运行·实例 relay 连接（W3b，数据面）
export {
  closeAllRelayConnections,
  closeInstanceRelay,
  closeRelayConnectionsForIdleReclaim,
  closeRelayConnectionsForStoppedInstance,
  extractAcpEvent,
  extractJsonRpc,
  reclaimInstanceYjsDocs,
  sendToInstanceRelay,
} from "./server/transport/relay"; // 运行·前端 relay/YJS 生命周期与 ACP 帧解析（W3b；不再随整目录透出）
export { closeClientsForMachineInstances } from "./server/transport/relay/client-close"; // 运行·机器实例的前端连接关闭（W3b）
export * from "./server/transport/relay/external-relay"; // 泄漏·external-relay 内部状态（W6：observer 读取）
export type { RelayLifecyclePort } from "./server/transport/relay/lifecycle-port"; // 宿主注入·relay 生命周期回调契约
export {
  bindRelayLifecyclePort,
  closeRelayClientsForMachine,
  resetRelayLifecyclePort,
} from "./server/transport/relay/lifecycle-port"; // 宿主注入·relay 生命周期绑定（Chat 装配层调用）
export * from "./services/acp-idle-monitor"; // 运行·空闲回收巡检与实例活跃度（W3b）
export * from "./services/agent-chat-service"; // 运行·会话与 turn（W3b，数据面）
export * from "./services/agent-concurrency"; // 运行·并发配额与 spawn 预留（W3b）
export * from "./services/environment"; // 运行·环境领域聚合面（W3b）
export * from "./services/environment-acp"; // 运行·ACP 环境注册与 Secret 读取（W3b）
export * from "./services/environment-core"; // 运行·环境核心读写与授权校验（W3b）
export * from "./services/environment-startup-lock"; // 运行·环境启动锁（W3b）
export * from "./services/instance-registry"; // 运行·实例注册表（W3b）
export * from "./services/launch-spec-builder"; // 运行·启动参数组装（W4 随 AgentInstanceStarter 搬出）
export * from "./services/orchestration-bootstrap"; // 运行·编排域装配（W3b）
export * from "./services/orchestration-instance"; // 运行·实例 spawn/stop 编排（W3b）
export * from "./services/orchestration-machine-cleanup"; // 运行·机器下线清理（W3b）
export * from "./services/session"; // 运行·RCS 会话记录（W3b）
export * from "./transport/agent-node-bridge"; // 运行·本地 AgentNode 桥接（W3b 前无 port 归属）
export * from "./transport/event-bus"; // 泄漏·包内事件总线（W6：observer/workflow 读订阅表）
export * from "./types/acp-connection"; // 运行态类型·ACP 连接登记项与快照
export * from "./types/auth"; // 运行态类型·鉴权上下文
export * from "./types/environment"; // 运行态类型·环境注册报文
export * from "./types/instance"; // 运行态类型·实例注册表补充字段
export * from "./types/ws-types"; // 运行态类型·WsConnection（使 AcpConnectionEntry["ws"] 派生可在包外解析）
