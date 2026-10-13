import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import type {
  AgentLaunchSpec,
  ConnectRelayInput,
  EngineRelayHandle,
  EngineRelayMessage,
  EngineRuntime,
  PrepareEnvironmentInput,
  StartInstanceInput,
  StopInstanceInput,
} from "@fenix/plugin-sdk";
import { buildAgentProcessEnv } from "acp-link/spawn-env";
import { prepareLaunchWorkspace, prepareWorkspaceEnvironment } from "./environment";
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
 * runtime 子模块的依赖注入接口。
 */
export interface ClaudeCodeRuntimeDependencies {
  /**
   * workspace 根目录（绝对路径）。
   *
   * 由宿主本地执行装配点注入 `getAgentRuntimeConfig().workspaceRoot`。本包不再自行解析 workspace 根（也不读
   * 进程环境变量）：旧实现按 `join(organizationId, userId, environmentId)` 拼**相对路径**，实际落点是
   * 「宿主进程 cwd / org / user / env」——既不是 `{WORKSPACE_ROOT}/{org}/{user}/{env}` 的形态，又与宿主解析出的
   * 根目录静默分叉，排障时表现为「skill 装到了预期目录外」。缺装配时 `resolveWorkspace` 当场报错，不做静默回落。
   */
  workspaceRoot?: string;
}

/**
 * Claude Code engine runtime。
 * 通过 spawn acp-link 子进程方式管理 Claude Code Agent 实例。
 */
export function createClaudeCodeRuntime(dependencies: ClaudeCodeRuntimeDependencies = {}): EngineRuntime {
  const instances = new Map<string, InstanceState>();
  const workspaceRoot = dependencies.workspaceRoot;

  /**
   * 按 `{root}/{org}/{user}/{env}` 形态解析实例 workspace；无 environmentId 时退到 `{root}/{org}/{user}`
   * （与 ccb / opencode / peri 三个 runtime 同形）。
   */
  function resolveWorkspace(spec: AgentLaunchSpec): string {
    if (!workspaceRoot) {
      throw new Error("claude-code runtime 未注入 workspaceRoot：宿主装配必须提供 workspace 根目录");
    }
    if (spec.environmentId) {
      return join(workspaceRoot, spec.organizationId, spec.userId, spec.environmentId);
    }
    return join(workspaceRoot, spec.organizationId, spec.userId);
  }

  return {
    async prepareEnvironment(input: PrepareEnvironmentInput): Promise<void> {
      const workspace = resolveWorkspace(input.launchSpec);
      const spec = await prepareLaunchWorkspace(workspace, input.launchSpec);
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
