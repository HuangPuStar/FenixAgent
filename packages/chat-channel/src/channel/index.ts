// packages/chat-channel/src/channel/index.ts
// 控制面导出（C3：CommandCoordinator + SessionChannel + Action/Ack 协议类型；
// C6：连接层 gateway / broadcaster / connection-registry / relay-event-handler）。

export { type ForwardYjsActionDependencies, flushPendingYjsActions, forwardYjsAction } from "./action-forward";
export { YjsBroadcaster } from "./broadcaster";
export {
  CommandCoordinator,
  type CommandCoordinatorDependencies,
} from "./command-coordinator";
export { ConnectionRegistry } from "./connection-registry";
export type {
  ClientConnection,
  RelayMessage,
  SharedRelay,
  WsConnection,
} from "./connection-types";
export { ChatChannelController, type ChatChannelDependencies } from "./controller";
export {
  Gateway,
  type GatewayDependencies,
  type GatewayEnvironment,
} from "./gateway";
export {
  RelayEventHandler,
  type RelayEventHandlerDependencies,
} from "./relay-event-handler";
export {
  SessionChannel,
  type SessionChannelDependencies,
  type SessionConnection,
} from "./session-channel";
export {
  ACTION_ACK_STATUSES,
  ACTION_ERROR_CODES,
  type ActionAck,
  type ActionAckStatus,
  type ActionError,
  type ActionErrorCode,
  type ActionSinks,
  type ActionType,
  type ClientAction,
  type Command,
  CommandExecutionError,
  type CommandOutcome,
  KNOWN_ACTION_TYPES,
  MAX_ACTION_PAYLOAD_BYTES,
} from "./types";
