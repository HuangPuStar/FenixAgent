/** 服务端 Agent Runtime 的公开装配入口。 */

export { default as acpRoutes } from "./routes/acp";
export { default as apiInstanceRoutes } from "./routes/api/instances";
export { default as openaiChatRoutes } from "./routes/api/openai-chat";
export * from "./schemas/acp.schema";
export * from "./schemas/environment.schema";
export type {
  InstanceActivityInfo as InstanceSchemaActivityInfo,
  InstanceActivityListResponse,
  InstanceInfo as InstanceSchemaInfo,
  InstanceListResponse,
  InstanceStatus,
  SpawnInstanceFromEnvironmentRequest,
  SpawnInstanceFromEnvironmentResponse,
} from "./schemas/instance.schema";
export {
  InstanceActivityInfoSchema,
  InstanceActivityListResponseSchema,
  InstanceActivityQuerySchema,
  InstanceInfoSchema,
  InstanceListResponseSchema,
  InstanceStatusSchema,
  SpawnInstanceFromEnvironmentRequestSchema,
  SpawnInstanceFromEnvironmentResponseSchema,
} from "./schemas/instance.schema";
export * from "./schemas/openai-chat.schema";
// 模块配置读取入口：本包 7 个运行态旋钮（并发上限、ACP 超时、WS 保活）的唯一真相，宿主经
// `initializeApplicationInfrastructure({ moduleConfigs })` 注入。测试装配入口在 `./server/testing`，不出现在这里。
export * from "./server/config";
export * from "./server/instance/agent-instance-id";
export * from "./server/repositories";
export * from "./server/repositories/environment-orchestration";
export * from "./server/services/agent-instance-runtime-coordinator";
export * from "./server/services/agent-instance-runtime-projection";
export * from "./server/services/agent-instance-service";
export * from "./server/services/api-instance";
export * from "./server/services/chat-channel-bootstrap";
export * from "./server/services/core-runtime-port";
export * from "./server/services/environment-web";
export * from "./server/services/file-ws-port";
export * from "./server/services/local-node-agent-node-service-port";
export * from "./server/services/machine-registry-port";
export * from "./server/services/session-event-bus-port";
export { resolveWorkspacePath } from "./server/services/workspace-resolver";
export * from "./server/transport/acp-ws-handler";
export * from "./server/transport/agent-relay";
export * from "./server/transport/relay";
export * from "./server/transport/relay/external-relay";
export * from "./services/acp-idle-monitor";
export * from "./services/agent-chat-service";
export * from "./services/agent-concurrency";
export * from "./services/environment";
export * from "./services/environment-acp";
export * from "./services/environment-core";
export * from "./services/environment-startup-lock";
export * from "./services/instance-registry";
export * from "./services/launch-spec-builder";
export * from "./services/orchestration-bootstrap";
export * from "./services/orchestration-instance";
export * from "./services/orchestration-machine-cleanup";
export * from "./services/session";
export * from "./transport/agent-node-bridge";
export * from "./transport/event-bus";
// 本包运行态类型（1.4 W1 从宿主 `@server/types/*` 收回）：ACP 连接登记项与快照、实例注册表补充字段、
// 环境注册报文。`WsConnection` 一并导出，使 `AcpConnectionEntry["ws"]` 这类派生在包外可解析。
export * from "./types/acp-connection";
export * from "./types/environment";
export * from "./types/instance";
export * from "./types/ws-types";
