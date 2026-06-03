import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentLaunchSpec,
  ConnectRelayInput,
  EngineRelayHandle,
  EngineRuntime,
  PrepareEnvironmentInput,
  StartInstanceInput,
  StopInstanceInput,
} from "@fenix/plugin-sdk";
import { AcpLinkProcessManager, type ManagedAcpLinkProcess } from "../process/acp-link-process-manager";
import { createPortAllocator, type PortAllocator } from "../process/port-allocator";
import { type CcbRelayHandle, createRelayHandle, type RelayHandleDependencies } from "../relay/relay-handle";
import { prepareWorkspaceEnvironment } from "./environment-preparer";
import { buildCcbRuntimeConfig, type CcbRuntimeConfig, type InstalledSkillReference } from "./runtime-config";
import { installSkills, type SkillInstallerDependencies } from "./skill-installer";

const RELAY_CONNECT_MAX_ATTEMPTS = 20;
const RELAY_CONNECT_RETRY_DELAY_MS = 100;

export type RuntimeStatus = "idle" | "prepared" | "starting" | "running" | "stopped" | "error";

/**
 * runtime 为单个实例保存的内部状态。
 */
export interface RuntimeInstanceState {
  instanceId: string;
  status: RuntimeStatus;
  launchSpec?: AgentLaunchSpec;
  workspace?: string;
  env?: Record<string, string>;
  runtimeConfig?: CcbRuntimeConfig;
  installedSkills?: InstalledSkillReference[];
  process?: ManagedAcpLinkProcess | null;
  port?: number | null;
  token?: string | null;
  relay?: EngineRelayHandle | null;
  error?: string | null;
}

/**
 * runtime 子模块的依赖注入接口。
 *
 * Task 2~4 会逐步把 prepare/process/relay 实现注入进来，避免生命周期方法
 * 把逻辑散落在多个独立的全局模块里。
 */
export interface CcbRuntimeDependencies {
  accessWorkspace?: (workspace: string, mode: number) => Promise<void>;
  buildRuntimeConfig?: (launchSpec: AgentLaunchSpec, installedSkills: InstalledSkillReference[]) => CcbRuntimeConfig;
  createRelayHandle?: typeof createRelayHandle;
  portAllocator?: PortAllocator;
  processManager?: AcpLinkProcessManager;
  prepareWorkspaceEnvironment?: typeof prepareWorkspaceEnvironment;
  relayHandleDependencies?: RelayHandleDependencies;
  skillInstallerDependencies?: SkillInstallerDependencies;
  installSkills?: typeof installSkills;
  prepareEnvironment?: (input: PrepareEnvironmentInput, state: RuntimeInstanceState) => Promise<void>;
  startInstance?: (input: StartInstanceInput, state: RuntimeInstanceState) => Promise<void>;
  connectRelay?: (input: ConnectRelayInput, state: RuntimeInstanceState) => Promise<EngineRelayHandle>;
  stopInstance?: (input: StopInstanceInput, state: RuntimeInstanceState) => Promise<void>;
}

export interface CcbRuntime extends EngineRuntime {
  getInstanceState(instanceId: string): RuntimeInstanceState | undefined;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getOrCreateState(states: Map<string, RuntimeInstanceState>, instanceId: string): RuntimeInstanceState {
  const existing = states.get(instanceId);
  if (existing) {
    return existing;
  }
  const created: RuntimeInstanceState = {
    instanceId,
    status: "idle",
    port: null,
    token: null,
    relay: null,
    error: null,
  };
  states.set(instanceId, created);
  return created;
}

/**
 * 创建 ccb (claude --acp) runtime。
 */
export function createCcbRuntime(dependencies: CcbRuntimeDependencies = {}): CcbRuntime {
  const states = new Map<string, RuntimeInstanceState>();
  const accessWorkspace = dependencies.accessWorkspace ?? access;
  const installSkillsImpl = dependencies.installSkills ?? installSkills;
  const buildRuntimeConfig = dependencies.buildRuntimeConfig ?? buildCcbRuntimeConfig;
  const createRelayHandleImpl = dependencies.createRelayHandle ?? createRelayHandle;
  const portAllocator = dependencies.portAllocator ?? createPortAllocator();
  const processManager = dependencies.processManager ?? new AcpLinkProcessManager();
  const prepareWorkspace = dependencies.prepareWorkspaceEnvironment ?? prepareWorkspaceEnvironment;

  function resolveWorkspace(launchSpec: AgentLaunchSpec): string {
    const root = process.env.WORKSPACE_ROOT ?? join(process.cwd(), "workspaces");
    if (launchSpec.environmentId) {
      return join(root, launchSpec.organizationId, launchSpec.userId, launchSpec.environmentId);
    }
    return join(root, launchSpec.organizationId, launchSpec.userId);
  }

  return {
    getInstanceState(instanceId) {
      return states.get(instanceId);
    },

    async prepareEnvironment(input) {
      const state = getOrCreateState(states, input.instanceId);
      const workspacePath = resolveWorkspace(input.launchSpec);
      await mkdir(workspacePath, { recursive: true });
      await accessWorkspace(workspacePath, constants.R_OK | constants.W_OK);

      const installedSkills = await installSkillsImpl(
        workspacePath,
        input.launchSpec.skills,
        dependencies.skillInstallerDependencies,
      );
      const runtimeConfig = buildRuntimeConfig(input.launchSpec, installedSkills);
      await prepareWorkspace(
        workspacePath,
        runtimeConfig,
        input.launchSpec.env ? { ...input.launchSpec.env } : {},
        installedSkills,
      );

      state.launchSpec = input.launchSpec;
      state.workspace = workspacePath;
      state.env = input.launchSpec.env ? { ...input.launchSpec.env } : {};
      state.runtimeConfig = runtimeConfig;
      state.installedSkills = installedSkills;
      state.error = null;

      try {
        if (dependencies.prepareEnvironment) {
          await dependencies.prepareEnvironment(input, state);
        }
        state.status = "prepared";
      } catch (error) {
        state.status = "error";
        state.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },

    async startInstance(input) {
      const state = getOrCreateState(states, input.instanceId);
      if (!state.workspace || !state.launchSpec) {
        throw new Error(`Instance ${input.instanceId} must be prepared before start`);
      }
      if (state.status === "running" && state.process) {
        return;
      }
      state.error = null;
      state.status = "starting";

      try {
        const port = await portAllocator.allocate();
        const process = await processManager.start({
          instanceId: input.instanceId,
          workspace: state.workspace,
          port,
          env: state.env,
        });
        state.process = process;
        state.port = process.port;
        state.token = process.token;

        if (dependencies.startInstance) {
          await dependencies.startInstance(input, state);
        }
        state.status = "running";
      } catch (error) {
        if (state.port) {
          portAllocator.release(state.port);
        }
        state.process = null;
        state.port = null;
        state.token = null;
        state.status = "error";
        state.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },

    async connectRelay(input) {
      const state = getOrCreateState(states, input.instanceId);
      if (state.status !== "running" || !state.port || state.token == null) {
        throw new Error(`Instance ${input.instanceId} is not running`);
      }
      if (state.relay && state.relay.state === "open") {
        return state.relay;
      }

      try {
        if (dependencies.connectRelay) {
          const relay = await dependencies.connectRelay(input, state);
          state.relay = relay;
          return relay;
        }

        let lastError: unknown = null;
        for (let attempt = 1; attempt <= RELAY_CONNECT_MAX_ATTEMPTS; attempt += 1) {
          const relay = createRelayHandleImpl(
            {
              instanceId: input.instanceId,
              port: state.port,
              token: state.token,
            },
            dependencies.relayHandleDependencies ?? {
              createWebSocket: (url) => new WebSocket(url) as never,
            },
          );
          const relayHandle = relay as Partial<CcbRelayHandle>;

          try {
            if (relayHandle.ready) {
              await relayHandle.ready;
            }
            state.relay = relay;
            return relay;
          } catch (error) {
            lastError = error;
            await relay.close();
            if (attempt < RELAY_CONNECT_MAX_ATTEMPTS) {
              await delay(RELAY_CONNECT_RETRY_DELAY_MS);
            }
          }
        }

        throw lastError instanceof Error ? lastError : new Error("Relay failed to open");
      } catch (error) {
        state.status = "error";
        state.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },

    async stopInstance(input) {
      const state = getOrCreateState(states, input.instanceId);
      if (state.status === "stopped" || (!state.process && !state.port)) {
        state.status = "stopped";
        return;
      }

      try {
        if (state.relay && state.relay.state === "open") {
          await state.relay.close();
        }
        state.relay = null;
        await processManager.stop(input.instanceId);
        if (dependencies.stopInstance) {
          await dependencies.stopInstance(input, state);
        }
        if (state.port) {
          portAllocator.release(state.port);
        }
        state.process = null;
        state.port = null;
        state.token = null;
        state.status = "stopped";
      } catch (error) {
        state.status = "error";
        state.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
  };
}
