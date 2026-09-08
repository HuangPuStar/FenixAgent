// packages/chat-channel/src/index.ts
// 浏览器安全入口：web 侧 vite alias（web/vite.config.ts）与 tsconfig paths
// 直连本文件，因此这里 re-export 的模块图会整体进入浏览器 bundle。
//
// 约束：只允许导出无 node 运行时依赖的共享面——类型、schema、chat-writer
// （纯 yjs 写入/读取原语）、yjs-store（前端 store）、protocol（帧编解码）、
// transport（WS 客户端）、util。服务端能力（channel 控制面、persist 持久化、
// state 聚合层 DocManager/factory/aggregator 等）必须经
// `@fenix/chat-channel/server` 子路径导出；从本文件 re-export 服务端模块会
// 直接打穿边界（2026-08-17 事故：persist/snapshot-framing 顶层 node:crypto
// 经 state/factory 引用链进入前端 bundle，整包加载崩溃）。
// 守护测试：src/__tests__/chat-channel-browser-surface.test.ts（走根入口值
// 导入图，断言不触及 node 内建 / ioredis / 服务端模块）。

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
// ── Action/Ack 协议类型（channel/types.ts 的类型子集，前端 ChatPanel 消费）。
// type-only 转导在编译期整体擦除，不会把 channel 模块图带入浏览器 bundle，
// 守护测试按值导入图判定，不视为边界突破──
export type { ActionAck, ActionError } from "./channel/types";
export * from "./protocol";
export * from "./public-error";
// ── schema 类型（显式导出，排除 ContentBlock：该名字与 acp-link 协议块类型冲突，
// 包对外统一为 acp-link 版本，Chat 域内部块类型仍从 schema.ts 直接引用）──
export {
  type AgentRuntimeStatus,
  type AgentStatusProjection,
  CHAT_DOC_SCHEMA_VERSION,
  type ChatEntry,
  type ChatEntryKind,
  type ChatEntryRole,
  type ChatEntryStatus,
  DEFAULT_QUESTION_TIMEOUT_MS,
  hasQuestionAnswer,
  INITIAL_PROJECTION_VERSION,
  type NormalizedEvent,
  type NormalizedEventType,
  type NormalizedPeriTaskEvent,
  normalizeQuestionAnswers,
  PERI_AGENT_EVENT_CAPABILITY,
  PERI_AGENT_EVENT_METHOD,
  PERI_AGENT_EVENT_TYPES,
  PERI_TASK_EVENT_TYPES,
  PERI_TASK_FALLBACK_TITLE,
  PERI_TASK_SUBTYPE_ALLOWLIST,
  PERI_TASK_SUMMARY_MAX,
  PERI_TASK_TITLE_MAX,
  PERI_TASK_VIEW_MAX,
  PERI_UNSTABLE_EVENT_CAPABILITY,
  PERI_UNSTABLE_EVENT_METHOD,
  PERI_UNSTABLE_EVENT_NAMES,
  type PeriTaskDetailAvailability,
  type PeriTaskKind,
  type PeriTaskStatus,
  type PeriTaskSubtype,
  type PeriTaskViewProjection,
  type PermissionOptionKind,
  type PermissionProjection,
  type PermissionStatus,
  type PublicError,
  type QuestionAnswer,
  type QuestionItemProjection,
  type QuestionOptionProjection,
  type QuestionProjection,
  type QuestionStatus,
  SESSION_BOUND_NOTIFICATION_METHODS,
  SESSION_DOC_SCHEMA_VERSION,
  type SessionDocStatus,
  type SessionInfoProjection,
  type SessionSummaryProjection,
  type ToolCallProjection,
  type ToolCallStatus,
  TURN_TERMINAL_STATUSES,
  type TurnStatus,
  truncateUtf8Safe,
} from "./schema";
// ── state 浏览器安全子集（聚合层 DocManager/factory/aggregator 等服务端模块
// 见 @fenix/chat-channel/server）──
export * from "./state/chat-writer";
export * from "./state/yjs-store";
export * from "./transport";
export * from "./types";
export * from "./util";
