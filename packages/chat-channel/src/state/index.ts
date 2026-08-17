export { type ApplyResult, applyNormalizedEvent, type DocPair } from "./aggregator";
export {
  appendEntryText,
  bumpProjectionVersion,
  clearChatDocContent,
  clearSessionDocContent,
  type EntryInit,
  ensureEntry,
  getAgentStatus,
  getChatRoot,
  getEntriesMap,
  getEntry,
  getEntryOrder,
  getPendingPermissions,
  getPendingQuestions,
  getSessionInfo,
  getSessionRoot,
  getToolCallsMap,
  hasChatDocContent,
  initChatDocStructure,
  initSessionDocStructure,
  setActiveTurn,
  setAgentStatus,
  setEntryStatus,
  setEntryTokenUsage,
  setSessionAvailableCommands,
  setSessionInfo,
  setToolCallStatus,
  type ToolCallInit,
  upsertPendingPermission,
  upsertPendingQuestion,
  upsertToolCall,
} from "./chat-writer";
export {
  DocManager,
  type DocManagerOptions,
  type PermissionRequestedHandler,
  type QuestionRequestedHandler,
} from "./doc-manager";
export {
  createChatDoc,
  createSessionDoc,
  loadChatDoc,
  loadSessionDoc,
} from "./factory";
export { expireQuestion, respondQuestion } from "./question";
export {
  applyRemoteDocUpdate,
  createYjsStore,
  type SwitchDocBinding,
  type YjsStore,
} from "./yjs-store";
