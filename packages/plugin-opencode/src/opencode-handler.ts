import { buildOpencodeRuntimeConfig, installSkills, writeOpencodeConfig } from "@fenix/opencode";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { AcpDispatcher } from "../../acp-link/src/acp-dispatcher.js";
import { spawnAcpAgent } from "../../acp-link/src/client/acp-spawn-helper.js";
import type { EngineHandler, EngineStartContext } from "../../acp-link/src/client/instance-manager.js";
import { resolveExecutable } from "../../acp-link/src/client/resolve-executable.js";

/**
 * OpenCode 引擎 handler：spawn opencode acp 子进程，通过 ACP stdio 通信。
 */
export function createOpencodeHandler(binary?: string, extraArgs?: string[]): EngineHandler {
  // 延迟到 startInstance 才 resolve executable，避免机器上没有 opencode 时启动失败
  const binaryName = binary ?? "opencode";
  const args = extraArgs ?? ["acp"];

  return {
    async prepareWorkspace(workspace: string, launchSpec: AgentLaunchSpec): Promise<void> {
      const installedSkills = await installSkills(workspace, launchSpec.skills);
      const runtimeConfig = buildOpencodeRuntimeConfig(launchSpec, installedSkills);
      await writeOpencodeConfig(workspace, runtimeConfig);
    },

    async startInstance(ctx: EngineStartContext) {
      const { state, instanceId, send } = ctx;

      const resolved = resolveExecutable(binaryName);

      const {
        process: proc,
        connection,
        capabilities,
      } = await spawnAcpAgent(resolved, args, state.workspace, state.launchSpec.env, send);

      proc.on("exit", (code) => {
        console.log(`[opencode-handler] opencode exited: ${instanceId}, code=${code}`);
        state.process = null;
        state.connection = null;
      });

      state.process = proc;
      state.connection = connection;
      state.capabilities = capabilities;
      state.sessionState.connection = connection;
      // 从 initResult.agentCapabilities 提取结构化字段（与 main 分支逻辑一致）
      const agentCaps = capabilities as Record<string, unknown> | null;
      state.sessionState.agentCapabilities = agentCaps
        ? {
            _meta: (agentCaps._meta as Record<string, unknown> | null) ?? undefined,
            loadSession: agentCaps.loadSession as boolean | undefined,
            mcpCapabilities: agentCaps.mcpCapabilities as Record<string, unknown> | undefined,
            promptCapabilities: agentCaps.promptCapabilities as Record<string, unknown> | undefined,
            sessionCapabilities: agentCaps.sessionCapabilities as Record<string, unknown> | undefined,
          }
        : null;
      state.sessionState.promptCapabilities = (agentCaps?.promptCapabilities as Record<string, unknown> | null) ?? null;
      state.dispatcher = new AcpDispatcher(state.sessionState, { send, workspace: state.workspace });

      console.log(`[opencode-handler] started: ${instanceId}`);
      return { capabilities };
    },

    async stopInstance(state) {
      if (state.process && !state.process.killed) {
        state.process.kill("SIGTERM");
      }
    },
  };
}
