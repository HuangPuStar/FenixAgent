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
import { buildAgentProcessEnv } from "acp-link/spawn-env";
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
 * 读取宿主进程的单个配置键，仅在已定义时返回该项，避免把 `undefined` 写进子进程环境。
 *
 * 为什么不加进 `buildAgentProcessEnv` 的白名单：本仓模型配置的既有架构是经 launchSpec /
 * settings 文件显式下发，白名单越短越安全；按前缀放宽（`ANTHROPIC_*`）会让宿主密钥随下一次
 * 改名重新泄漏。而 acp-link 进程内的 `claude-acp-adapter` 直读 `ANTHROPIC_MODEL`（模型列表
 * 回退值）与 `CLAUDE_CODE_CLI_PATH`（Claude CLI 可执行路径，即 `pathToClaudeCodeExecutable`），
 * 故由本调用点逐键显式补齐，其余宿主密钥仍被白名单拦住。
 */
function pickDefinedHostEnv(key: string): Record<string, string> {
  const value = process.env[key];
  return value === undefined ? {} : { [key]: value };
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
        // acp-link 子进程同样只吃白名单：宿主密钥不经继承透传。
        // acp-link 进程内直读的两个配置键由本调用点显式补齐（理由见 pickDefinedHostEnv）。
        env: buildAgentProcessEnv({
          ACP_ENGINE_TYPE: "claude-code",
          ...pickDefinedHostEnv("ANTHROPIC_MODEL"),
          ...pickDefinedHostEnv("CLAUDE_CODE_CLI_PATH"),
        }),
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
