import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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

      // 创建 .claude 配置目录
      const claudeDir = join(workspace, ".claude");
      await mkdir(claudeDir, { recursive: true });

      // 写入基础 settings.json
      const settings = {
        permissions: {
          defaultMode: "default",
        },
      };
      await writeFile(join(claudeDir, "settings.json"), JSON.stringify(settings, null, 2));

      instances.set(input.instanceId, {
        envId: input.launchSpec.environmentId ?? "",
        workspace,
        process: null,
        port: 0,
        token: "",
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
