import type {
  ConnectRelayInput,
  EnginePlugin,
  EngineRelayHandle,
  EngineRelayMessage,
  EngineRuntime,
  PrepareEnvironmentInput,
  StartInstanceInput,
  StopInstanceInput,
} from "@mothership/plugin-sdk";

/**
 * fake engine runtime 记录的调用类型。
 */
export type FakeEngineCall = "prepare" | "start" | "stop" | "connectRelay";

/**
 * fake relay 句柄，支持记录发送消息与关闭状态。
 */
export interface FakeRelayHandle extends EngineRelayHandle {
  sentMessages: EngineRelayMessage[];
}

/**
 * fake runtime 暴露给测试断言的状态。
 */
export interface FakeEngineRuntimeState {
  calls: FakeEngineCall[];
  lastPrepareInput?: PrepareEnvironmentInput;
  lastStartInput?: StartInstanceInput;
  lastStopInput?: StopInstanceInput;
  lastConnectRelayInput?: ConnectRelayInput;
  connectRelayCalls: number;
  relay: FakeRelayHandle;
}

/**
 * fake plugin 的可选故障注入。
 */
export interface FakeEnginePluginOptions {
  engineType?: string;
  failOnPrepare?: unknown;
  failOnStart?: unknown;
  failOnConnectRelay?: unknown;
  failOnStop?: unknown;
}

/**
 * 构造一个可复用的 fake relay 句柄。
 */
export function createFakeRelayHandle(): FakeRelayHandle {
  const sentMessages: EngineRelayMessage[] = [];
  let relayState: "open" | "closed" = "open";

  return {
    get state() {
      return relayState;
    },
    sentMessages,
    send(message) {
      sentMessages.push(message);
    },
    close() {
      relayState = "closed";
    },
  };
}

/**
 * 构造一个可供测试观察的 fake runtime 状态对象。
 */
export function createFakeEngineRuntimeState(): FakeEngineRuntimeState {
  return {
    calls: [],
    connectRelayCalls: 0,
    relay: createFakeRelayHandle(),
  };
}

function throwConfiguredError(error: unknown): never {
  throw error;
}

/**
 * 创建一个带调用痕迹与故障注入能力的 fake engine plugin。
 */
export function createFakeEnginePlugin(
  options: FakeEnginePluginOptions = {},
): EnginePlugin & { runtimeState: FakeEngineRuntimeState } {
  const runtimeState = createFakeEngineRuntimeState();

  const runtime: EngineRuntime = {
    async prepareEnvironment(input) {
      runtimeState.calls.push("prepare");
      runtimeState.lastPrepareInput = input;
      if (options.failOnPrepare !== undefined) {
        throwConfiguredError(options.failOnPrepare);
      }
    },
    async startInstance(input) {
      runtimeState.calls.push("start");
      runtimeState.lastStartInput = input;
      if (options.failOnStart !== undefined) {
        throwConfiguredError(options.failOnStart);
      }
    },
    async stopInstance(input) {
      runtimeState.calls.push("stop");
      runtimeState.lastStopInput = input;
      if (options.failOnStop !== undefined) {
        throwConfiguredError(options.failOnStop);
      }
    },
    async connectRelay(input) {
      runtimeState.calls.push("connectRelay");
      runtimeState.connectRelayCalls += 1;
      runtimeState.lastConnectRelayInput = input;
      if (options.failOnConnectRelay !== undefined) {
        throwConfiguredError(options.failOnConnectRelay);
      }
      return runtimeState.relay;
    },
  };

  return {
    meta: {
      id: options.engineType ?? "fake-engine",
      displayName: "Fake Engine",
      version: "0.1.0",
    },
    runtimeState,
    createRuntime() {
      return runtime;
    },
  };
}
