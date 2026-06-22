import type {
  ConnectRelayInput,
  EngineRelayHandle,
  EngineRuntime,
  PrepareEnvironmentInput,
  StartInstanceInput,
  StopInstanceInput,
} from "@fenix/plugin-sdk";
import { RemoteRelayHandle } from "./remote-relay-handle";
import type { RemoteTransport } from "./remote-transport";

export interface RemoteRuntimeOptions {
  transport: RemoteTransport;
}

export function createRemoteRuntime(options: RemoteRuntimeOptions): EngineRuntime {
  const { transport } = options;

  async function prepareEnvironment(input: PrepareEnvironmentInput): Promise<void> {
    const response = await transport.sendAndWait({
      type: "prepare",
      instance_id: input.instanceId,
      launch_spec: input.launchSpec,
      engine_type: input.engineType ?? "opencode",
    });

    if (response.status === "error") {
      throw new Error(response.message ?? "Remote prepare failed");
    }
  }

  async function startInstance(input: StartInstanceInput): Promise<void> {
    const response = await transport.sendAndWait({
      type: "start",
      instance_id: input.instanceId,
    });

    if (response.status === "error") {
      throw new Error(response.message ?? "Remote start failed");
    }
  }

  async function connectRelay(input: ConnectRelayInput): Promise<EngineRelayHandle> {
    return new RemoteRelayHandle(transport, input.instanceId, input.sessionId ?? input.instanceId);
  }

  async function stopInstance(input: StopInstanceInput): Promise<void> {
    try {
      await transport.sendAndWait({
        type: "stop",
        instance_id: input.instanceId,
      });
    } catch {
      // stop 幂等，远程超时或断连不抛错
    }
  }

  return {
    prepareEnvironment,
    startInstance,
    connectRelay,
    stopInstance,
  };
}
