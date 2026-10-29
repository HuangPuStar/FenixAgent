/** Channel 资源包的服务端公开入口（`@fenix/resource-channel/server`）。 */

// 浏览器面随前端阶段落地；本入口只导出服务端能力与它们的注入契约。根入口 `@fenix/resource-channel`
// 保持为空，避免消费方把 Elysia 端点与 DB 仓储拉进浏览器包。

export {
  createChannelApiSystemRoutes,
  createChannelImMcpRoutes,
  createChannelLangBotHookRoutes,
  createChannelLangBotWebRoutes,
} from "./server/assembly";
export { type ChannelModuleConfig, getChannelConfig } from "./server/config";
export { type ChannelActionResult, ChannelControlError, type ChannelControlErrorCode } from "./server/contracts";
export {
  type BotCreateInput,
  type BotUpdateInput,
  createLangBotChannelFacade,
  type LangBotChannelFacadeApi,
  type LangBotChannelFacadeDeps,
  type RouteCreateInput,
  type RouteUpdateInput,
} from "./server/facades/langbot-channel-facade";
export {
  type ChannelDataPlane,
  type ChannelModuleDeps,
  type ChannelServerModule,
  createChannelServerModule,
} from "./server/module";
export {
  bindChannelAgentConfigLookup,
  type ChannelAgentConfigLookup,
  type ChannelAgentConfigLookupResult,
  ChannelAgentConfigUnavailableError,
  getChannelAgentConfigLookup,
  resetChannelAgentConfigLookup,
} from "./server/ports/agent-config-lookup";
export {
  bindImSessionPort,
  getImSessionPort,
  type ImSessionHandle,
  type ImSessionInstanceInput,
  type ImSessionInstanceRef,
  type ImSessionOpenPortInput,
  type ImSessionPort,
  type ImSessionTarget,
  type ImWakePromptInput,
  resetImSessionPort,
} from "./server/ports/im-session";
export type { ImChannelRow } from "./server/repositories/im-channel";
export type { ImChannelConversationRow } from "./server/repositories/im-channel-conversation";
export type { ImChannelRouteRow } from "./server/repositories/im-channel-route";
export { createChannelSystemApiRoutes } from "./server/routes/api/system-channels";
export type { ChannelSystemApiRouteDependencies, ChannelWebRouteDependencies } from "./server/routes/dependencies";
export { createLangBotWebRoutes } from "./server/routes/web/langbot";
export { getChannelModule, installChannelModule, resetChannelModule } from "./server/runtime";
export * from "./server/schemas/channel-admin.schema";
export * from "./server/schemas/langbot.schema";
export {
  createImMcpService,
  type ImMcpService,
  type ImMcpServiceDeps,
} from "./server/services/im-mcp/service";
export {
  getImChannelSkill,
  IM_CHANNEL_SKILL_MARKDOWN,
  IM_CHANNEL_SKILL_NAME,
  IM_CHANNEL_SKILL_URI,
  listImChannelSkills,
} from "./server/services/im-mcp/skill";
export {
  IM_MCP_LEGACY_PROTOCOL_VERSION,
  IM_MCP_PROTOCOL_VERSION,
  IM_MCP_SERVER_CAPABILITIES,
  IM_MCP_SERVER_NAME,
  IM_MCP_SERVER_VERSION,
  ImMcpError,
  type ImMcpSession,
} from "./server/services/im-mcp/types";
export {
  type BotChannelSnapshot,
  type BotDetail,
  type BotListResult,
  type ChannelService,
  type ChannelServiceDeps,
  type ConversationListResult,
  createChannelService,
} from "./server/services/langbot/channel-service";
export {
  buildChannelTopology,
  type ChannelTopologyChannel,
  type ChannelTopologyDeps,
  type ChannelTopologyInput,
  type ChannelTopologyInstance,
  type ChannelTopologyOrganization,
  type ChannelTopologyUser,
  loadChannelTopology,
  readChannelStatus,
} from "./server/services/langbot/channel-topology";
export {
  createLangBotClient,
  type LangBotClient,
  type LangBotClientOptions,
} from "./server/services/langbot/client";
export {
  type ConversationService,
  type ConversationServiceDeps,
  createConversationService,
  createDeterministicImRcsSessionId,
  type EnsureConversationInput,
  type EnsureConversationResult,
} from "./server/services/langbot/conversation-service";
export {
  createDeliveryDispatcher,
  type DeliveryDispatcher,
  type DeliveryDispatcherDeps,
  type DeliveryTimer,
  IM_INBOX_RESOURCE_URI,
  type ImSubscriptionSink,
} from "./server/services/langbot/delivery-dispatcher";
export {
  clearExpiredImEventTexts,
  type ImEventMaintenanceResult,
  markInterruptedImDeliveriesFailed,
  runImEventMaintenance,
  startImEventMaintenance,
  stopImEventMaintenance,
} from "./server/services/langbot/event-maintenance";
export { buildImInstanceName } from "./server/services/langbot/im-instance-name";
export {
  createImSessionBridge,
  IM_WAKE_PROMPT_TEXT,
  type ImSessionBridge,
  type ImSessionBridgeDeps,
  ImSessionBridgeError,
  type ImSessionFailureCode,
  type ImSessionOpenOutcome,
} from "./server/services/langbot/im-session-bridge";
export { ImTokenError, issueImToken, verifyImToken } from "./server/services/langbot/im-token";
export {
  createInboundService,
  type ImInboundEventType,
  type InboundOutcome,
  type InboundRejectionReason,
  type InboundService,
  type InboundServiceDeps,
} from "./server/services/langbot/inbound-service";
export {
  createImOutboundService,
  IM_REPLY_CHUNK_SIZE,
  IM_REPLY_MAX_CHUNKS,
  type ImOutboundService,
  type ImOutboundServiceDeps,
  type ImReplyErrorCode,
  type ImReplyFailure,
  type ImReplyResult,
  type ImReplySuccess,
  splitImReplyText,
} from "./server/services/langbot/outbound-service";
export {
  type ChannelRouteCreateInput,
  type ChannelRouteService,
  type ChannelRouteServiceDeps,
  type ChannelRouteUpdatePatch,
  createChannelRouteService,
  findActiveRoute,
  groupInstancesByRoute,
  matchRoute,
  type RouteInstanceConversation,
  type RouteInstanceRef,
  type RouteMatchCandidate,
  type RouteMatchTarget,
} from "./server/services/langbot/route-service";
export type {
  CreateLangBotBotInput,
  LangBotBot,
  LangBotSendMessageInput,
  LangBotStatus,
  LangBotTargetType,
  UpdateLangBotBotInput,
} from "./server/services/langbot/types";
export { readBotUuid } from "./server/services/langbot/types";
export * from "./server/views/channel-view";
