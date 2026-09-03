import type {
  ConnectRelayInput,
  EngineRelayHandle,
  EngineRuntime,
  PrepareEnvironmentInput,
  StartInstanceInput,
  StopInstanceInput,
} from "@fenix/plugin-sdk";
import { RemoteRelayHandle } from "./remote-relay-handle";
import type { RemoteTransport, TransportMessage } from "./remote-transport";

export interface RemoteRuntimeOptions {
  transport: RemoteTransport;
  /** 当前主服务进程 epoch；remote lifecycle 必须显式提供。 */
  serverEpoch: string;
}

function fence(input: { instanceId: string; instanceUid?: string; runtimeGeneration?: number; serverEpoch?: string }): {
  instance_uid: string;
  runtime_generation: number;
  server_epoch: string;
} {
  if (!input.instanceUid || input.runtimeGeneration === undefined || !input.serverEpoch) {
    throw new Error(`Remote lifecycle fence is required for '${input.instanceId}'`);
  }
  return {
    instance_uid: input.instanceUid,
    runtime_generation: input.runtimeGeneration,
    server_epoch: input.serverEpoch,
  };
}

export function createRemoteRuntime(options: RemoteRuntimeOptions): EngineRuntime {
  const { transport } = options;

  async function prepareEnvironment(input: PrepareEnvironmentInput): Promise<void> {
    const msg: TransportMessage = {
      type: "prepare",
      instance_id: input.instanceId,
      launch_spec: input.launchSpec,
      ...(input.engineType ? { engine_type: input.engineType } : {}),
      ...fence(input),
    };
    const response = await transport.sendAndWait(msg);

    if (response.status === "error") {
      throw new Error(response.message ?? "Remote prepare failed");
    }
  }

  async function startInstance(input: StartInstanceInput): Promise<void> {
    const response = await transport.sendAndWait({
      type: "start",
      instance_id: input.instanceId,
      ...fence(input),
    });

    if (response.status === "error") {
      throw new Error(response.message ?? "Remote start failed");
    }
  }

  async function connectRelay(input: ConnectRelayInput): Promise<EngineRelayHandle> {
    return new RemoteRelayHandle(transport, input.instanceId, input.sessionId ?? input.instanceId, fence(input));
  }

  async function stopInstance(input: StopInstanceInput): Promise<void> {
    const response = await transport.sendAndWait({
      type: "stop",
      instance_id: input.instanceId,
      ...fence(input),
    });
    if (response.status === "error") {
      throw new Error(response.message ?? "Remote stop failed");
    }
  }

  return {
    prepareEnvironment,
    startInstance,
    connectRelay,
    stopInstance,
  };
}
