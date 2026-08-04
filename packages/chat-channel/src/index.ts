// ── 前端所需类型（web/src/acp/ 删除后，11 个组件直接从此包导入）──
// 协议类型来自 acp-link（AvailableCommand / SessionMode / ModelInfo 等），
// 由本包统一转导出，避免前端散落 import acp-link 子路径。
export type {
  AgentCapabilities,
  AgentSessionInfo,
  AvailableCommand,
  ConnectionState,
  ContentBlock,
  ImageContent,
  ListSessionsResponse,
  ModelInfo,
  PermissionRequestPayload,
  PermissionResponsePayload,
  PlanEntry,
  PlanEntryPriority,
  PlanEntryStatus,
  PromptCapabilities,
  PromptUsage,
  SessionCapabilities,
  SessionMode,
  SessionModelState,
  SessionModeState,
  SessionUpdate,
  ToolCallContent,
} from "acp-link/client";
export * from "./channel";
export * from "./persist";
export * from "./protocol";
// ── schema 类型（显式导出，排除 ContentBlock：该名字与 acp-link 协议块类型冲突，
// 包对外统一为 acp-link 版本，Chat 域内部块类型仍从 schema.ts 直接引用）──
export {
  type ActiveTurnProjection,
  type AgentRuntimeStatus,
  type AgentStatusProjection,
  CHAT_DOC_SCHEMA_VERSION,
  type ChatEntry,
  type ChatEntryKind,
  type ChatEntryRole,
  type ChatEntryStatus,
  INITIAL_PROJECTION_VERSION,
  type NormalizedEvent,
  type NormalizedEventType,
  type PermissionOptionKind,
  type PermissionProjection,
  type PermissionStatus,
  type PublicError,
  SESSION_DOC_SCHEMA_VERSION,
  type SessionDocStatus,
  type SessionInfoProjection,
  type ToolCallProjection,
  type ToolCallStatus,
  TURN_TERMINAL_STATUSES,
  type TurnStatus,
} from "./schema";
export * from "./state";
export * from "./transport";
export * from "./types";
export * from "./util";
