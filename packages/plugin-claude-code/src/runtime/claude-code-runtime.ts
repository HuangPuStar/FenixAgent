import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import type {
  ConnectRelayInput,
  EngineRelayHandle,
  EngineRelayMessage,
  EngineRuntime,
  PrepareEnvironmentInput,
  StartInstanceInput,
  StopInstanceInput,
} from "@fenix/plugin-sdk";
import { prepareWorkspaceEnvironment } from "./environment";
import { buildMcpConfig, buildSettings } from "./settings";
import { installSkills } from "./skill-installer";

interface InstanceState {
  envId: string;
  workspace: string;
  process: ChildProcess | null;
  port: number;
  token: string;
}

/**
 * Claude Code engine runtime。
 * 通过 spawn acp-link 子进程方式管理 Claude Code Agent 实例。
 */
export function createClaudeCodeRuntime(): EngineRuntime {
  const instances = new Map<string, InstanceState>();

  return {
    async prepareEnvironment(input: PrepareEnvironmentInput): Promise<void> {
      const spec = input.launchSpec;
      const workspace = join(spec.organizationId, spec.userId, spec.environmentId ?? "");
      const previous = instances.get(input.instanceId);

      const installedSkills = await installSkills(workspace, spec.skills);
      const settings = buildSettings(spec, installedSkills);
      const mcpConfig = buildMcpConfig(spec);
      await prepareWorkspaceEnvironment(workspace, settings, mcpConfig, spec.agent.prompt, installedSkills);

      instances.set(input.instanceId, {
        envId: spec.environmentId ?? "",
        workspace,
        process: previous?.process ?? null,
        port: previous?.port ?? 0,
        token: previous?.token ?? "",
      });
    },

    async startInstance(input: StartInstanceInput): Promise<void> {
      const state = instances.get(input.instanceId);
      if (!state) throw new Error(`Instance ${input.instanceId} not prepared`);

      // Claude Code 引擎通过 acp-link 子进程运行
      // acp-link 会根据 ACP_ENGINE_TYPE=claude-code 选择 claude-bridge
      const proc = spawn("acp-link", [], {
        cwd: state.workspace,
        stdio: ["pipe", "pipe", "inherit"],
        env: {
          ...process.env,
          ACP_ENGINE_TYPE: "claude-code",
        },
      });

      state.process = proc;
    },

    async connectRelay(_input: ConnectRelayInput): Promise<EngineRelayHandle> {
      // 返回一个基础 relay handle（Claude Code 通过 acp-link WebSocket 通信）
      const listeners = new Set<(message: EngineRelayMessage) => void>();
      return {
        state: "open",
        send(message: EngineRelayMessage): void {
          for (const listener of listeners) {
            listener(message);
          }
        },
        close(_code?: number, _reason?: string): void {
          // no-op
        },
        onMessage(listener: (message: EngineRelayMessage) => void): () => void {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    },

    async stopInstance(input: StopInstanceInput): Promise<void> {
      const state = instances.get(input.instanceId);
      if (!state) return;
      if (state.process && !state.process.killed) {
        state.process.kill("SIGTERM");
      }
      instances.delete(input.instanceId);
    },
  };
}
