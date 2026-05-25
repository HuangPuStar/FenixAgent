import type { AgentLaunchSpec } from "./agent-launch-spec";
import type { EngineRelayHandle } from "./engine-relay";

/**
 * Engine 插件静态元信息。
 */
export interface EnginePluginMeta {
  id: string;
  displayName: string;
  version: string;
}

/**
 * prepare 阶段输入。
 */
export interface PrepareEnvironmentInput {
  instanceId: string;
  launchSpec: AgentLaunchSpec;
}

/**
 * start 阶段输入。
 */
export interface StartInstanceInput {
  instanceId: string;
}

/**
 * stop 阶段输入。
 */
export interface StopInstanceInput {
  instanceId: string;
}

/**
 * 建立 relay 的输入。
 */
export interface ConnectRelayInput {
  instanceId: string;
  sessionId?: string;
}

/**
 * engine runtime 生命周期接口。
 */
export interface EngineRuntime {
  prepareEnvironment(input: PrepareEnvironmentInput): Promise<void>;
  startInstance(input: StartInstanceInput): Promise<void>;
  stopInstance(input: StopInstanceInput): Promise<void>;
  connectRelay(input: ConnectRelayInput): Promise<EngineRelayHandle>;
}

/**
 * Engine 插件入口。
 */
export interface EnginePlugin {
  meta: EnginePluginMeta;
  createRuntime(): EngineRuntime;
}
