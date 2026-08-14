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
  upsertToolCall,
} from "./chat-writer";
export { DocManager, type DocManagerOptions } from "./doc-manager";
export {
  createChatDoc,
  createSessionDoc,
  loadChatDoc,
  loadSessionDoc,
} from "./factory";
export { createYjsStore, type YjsStore } from "./yjs-store";
