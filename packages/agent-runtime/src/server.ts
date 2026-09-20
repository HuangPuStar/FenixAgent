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
 *
 * - `宿主注入·` 宿主实现、包内消费的 port，缺绑定即启动失败；
 * - `路由·`／`协议·`／`错误映射·`／`模块配置·` 宿主装配与协议接入面；
 * - `泄漏·` 内部实现泄漏，不属于任何 port（W6 按消费方收敛，**不得新增消费方**）；
 * - `测试取用·` 仅测试消费的实现细节（W6 随测试 seam 移出公开面）；
 * - `W4·` 启动参数组装（W4 随 `AgentInstanceStarter` 搬出）。
 *
 * 未收口标注的移除条件：`W4` = 启动前取数搬出后删除；`W6` = 泄漏与测试 seam 收口任务按包删除。
 * `测试取用·` 的判据是「删除即破坏用例」：其中跨包用例（workflow / observer）无法改相对导入，
 * 删行须先给出测试专用入口，属 W6「测试 seam 移出公开面」的裁量范围，本片不预判。
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
export * from "./server/services/agent-instance-service"; // 测试取用·实例生命周期服务（W6：宿主用例改写 resolve/ensure/snapshot）
export * from "./server/services/api-instance"; // 测试取用·程序化 API 实例入口（W6：包内用例取 setApiInstanceDeps/connectAgentInstance）
export * from "./server/services/chat-channel-bootstrap"; // 泄漏·Chat 域装配（W6：observer 取 chat channel 控制器）
export * from "./server/services/core-runtime-port"; // 宿主注入·Core runtime 与远端节点
export * from "./server/services/file-ws-port"; // 宿主注入·file-ws 连接可用性
export * from "./server/services/local-node-agent-node-service-port"; // 宿主注入·本地节点服务
export * from "./server/services/machine-registry-port"; // 宿主注入·机器注册表
export * from "./server/services/redis-connection-port"; // 宿主注入·Redis 连接
export * from "./server/services/session-event-bus-port"; // 宿主注入·会话事件总线
export { resolveWorkspacePath } from "./server/services/workspace-resolver"; // 泄漏·workspace 路径（W6：machine 直接依赖）
export * from "./server/transport/acp-ws-handler"; // 泄漏·ACP WS 帧处理与连接索引（W6：宿主与用例取机器连接/清理，observer 读连接表）
export {
  closeAllRelayConnections,
  closeInstanceRelay,
  closeRelayConnectionsForIdleReclaim,
  closeRelayConnectionsForStoppedInstance,
  extractAcpEvent,
  extractJsonRpc,
  reclaimInstanceYjsDocs,
  sendToInstanceRelay,
} from "./server/transport/relay"; // 泄漏·前端 relay/YJS 生命周期与 ACP 帧解析（W6：与 extractJsonRpc 收口同批，§1.6）
export * from "./server/transport/relay/external-relay"; // 泄漏·external-relay 内部状态（W6：observer 读取）
export type { RelayLifecyclePort } from "./server/transport/relay/lifecycle-port"; // 宿主注入·relay 生命周期回调契约
export {
  bindRelayLifecyclePort,
  closeRelayClientsForMachine,
  resetRelayLifecyclePort,
} from "./server/transport/relay/lifecycle-port"; // 宿主注入·relay 生命周期绑定（Chat 装配层调用）
export * from "./services/acp-idle-monitor"; // 测试取用·空闲回收巡检与实例活跃度（W6：用例取 shouldCountInstanceActivity/markInstanceRelayAttached）
export * from "./services/agent-chat-service"; // 测试取用·会话与 turn（W6：用例取 createPromptTurn/OpenAgentSessionResult 与两个数据面类型）
export {
  bindEnvironmentAcpLifecyclePort,
  KEBAB_CASE_RE,
  sanitizeResponse,
  validateWorkspacePath,
} from "./services/environment-core"; // 宿主注入·环境 ACP 生命周期绑定
export * from "./services/instance-registry"; // 测试取用·实例注册表（W6：跨包用例断言并发额度残留）
export * from "./services/launch-spec-builder"; // W4·启动参数组装（随 AgentInstanceStarter 搬出）
export * from "./services/orchestration-bootstrap"; // 测试取用·编排域装配（W6：宿主用例复位编排替身）
export * from "./services/orchestration-instance"; // 测试取用·实例 spawn/stop 编排（W6：宿主用例注入编排替身）
export * from "./transport/agent-node-bridge"; // 泄漏·本地 AgentNode 桥接（W6：宿主取节点服务，无 port 归属）
export * from "./transport/event-bus"; // 泄漏·包内事件总线（W6：observer/workflow 读订阅表）
export * from "./types/acp-connection"; // 运行态类型·ACP 连接登记项与快照
export * from "./types/auth"; // 运行态类型·鉴权上下文
export * from "./types/environment"; // 运行态类型·环境注册报文
export * from "./types/instance"; // 运行态类型·实例注册表补充字段
export * from "./types/ws-types"; // 运行态类型·WsConnection（使 AcpConnectionEntry["ws"] 派生可在包外解析）
