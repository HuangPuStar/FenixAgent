// Client-side ACP modules

// Re-export all types from the shared types module
export type * from "../types.js";
export type {
  AvailableCommandsChangedHandler,
  BrowserToolCallHandler,
  ConnectionStateHandler,
  ErrorMessageHandler,
  ModeChangedHandler,
  ModelChangedHandler,
  ModelStateChangedHandler,
  ModeStateChangedHandler,
  PermissionRequestHandler,
  PromptCompleteHandler,
  SessionCreatedHandler,
  SessionLoadedHandler,
  SessionSwitchingHandler,
  SessionUpdateHandler,
} from "./client.js";
export { ACPClient, DisconnectRequestedError } from "./client.js";
export type { Handler } from "./emitter.js";
// Internal modules (for advanced usage / testing)
export { EventEmitter } from "./emitter.js";
export { ACPPending } from "./pending.js";
export type { ProtocolEvents } from "./protocol.js";
export { ACPProtocol } from "./protocol.js";
export type { StateEvents } from "./state.js";
export { ACPState } from "./state.js";
export type { TransportEvents, TransportState } from "./transport.js";
export { WSTransport } from "./transport.js";
