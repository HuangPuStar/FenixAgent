// Client-side ACP modules
export { ACPClient, DisconnectRequestedError } from './client.js'
export type {
  ConnectionStateHandler,
  SessionUpdateHandler,
  SessionCreatedHandler,
  PromptCompleteHandler,
  PermissionRequestHandler,
  BrowserToolCallHandler,
  ErrorMessageHandler,
  ModelChangedHandler,
  ModelStateChangedHandler,
  AvailableCommandsChangedHandler,
  SessionLoadedHandler,
  SessionSwitchingHandler,
} from './client.js'

// Re-export all types from the shared types module
export type * from '../types.js'

// Internal modules (for advanced usage / testing)
export { EventEmitter } from './emitter.js'
export type { Handler } from './emitter.js'
export { WSTransport } from './transport.js'
export type { TransportState, TransportEvents } from './transport.js'
export { ACPProtocol } from './protocol.js'
export type { ProtocolEvents } from './protocol.js'
export { ACPPending } from './pending.js'
export { ACPState } from './state.js'
export type { StateEvents } from './state.js'
