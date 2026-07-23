import {
  buildCcbMcpConfig,
  buildCcbRuntimeConfig,
  installSkills as installCcbSkills,
  writeCcbConfig,
  writePeriSettings,
} from "@fenix/ccb";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { AcpDispatcher } from "acp-link/acp-dispatcher";
import { spawnAcpAgent } from "acp-link/client/acp-spawn-helper";
import type { EngineHandler, EngineStartContext } from "acp-link/client/instance-manager";
import { resolveExecutable } from "acp-link/client/resolve-executable";

/**
 * ccb 引擎 handler：spawn ccb --acp 子进程，通过 ACP stdio 通信。
 */
export function createCcbHandler(): EngineHandler {
  // 延迟到 startInstance 才 resolve executable，避免机器上没有 ccb 二进制时启动失败
  const binaryName = process.env.RCS_CCB_COMMAND ?? "ccb";
  const args = (process.env.RCS_CCB_ARGS ?? "--acp").split(/\s+/);

  return {
    async prepareWorkspace(workspace: string, launchSpec: AgentLaunchSpec): Promise<void> {
      const installedSkills = await installCcbSkills(workspace, launchSpec.skills);
      const runtimeConfig = buildCcbRuntimeConfig(launchSpec, installedSkills);
      await writeCcbConfig(workspace, runtimeConfig);

      const mcpConfig = buildCcbMcpConfig(launchSpec);
      if (mcpConfig) {
        const { writeCcbMcpConfig } = await import("@fenix/ccb");
        await writeCcbMcpConfig(workspace, mcpConfig);
        console.log(`[ccb-handler] wrote .mcp.json with ${Object.keys(mcpConfig.mcpServers).length} servers`);
      }

      if (launchSpec.agent.prompt) {
        const { writeClaudeMd } = await import("@fenix/ccb");
        await writeClaudeMd(workspace, launchSpec.agent.prompt);
        console.log("[ccb-handler] wrote CLAUDE.md");
      }

      await writePeriSettings(workspace, launchSpec);
    },

    async startInstance(ctx: EngineStartContext) {
      const { state, instanceId, send } = ctx;

      const resolved = resolveExecutable(binaryName);

      const {
        process: proc,
        connection,
        capabilities,
        resolvePermissionOutcome,
      } = await spawnAcpAgent(resolved, args, state.workspace, state.launchSpec.env, send);

      proc.on("exit", (code) => {
        console.log(`[ccb-handler] ccb exited: ${instanceId}, code=${code}`);
        state.process = null;
        state.connection = null;
      });

      // ccb 的 ACP 只支持单会话（newSession 永远返回同一个 sessionId）
      // 不伪装多会话能力，让前端按单会话模式工作
      state.process = proc;
      state.connection = connection;
      state.capabilities = capabilities;
      state.sessionState.connection = connection;
      const caps = capabilities as Record<string, unknown> | null;
      state.sessionState.agentCapabilities = caps
        ? {
            _meta: (caps._meta as Record<string, unknown> | null) ?? undefined,
            loadSession: caps.loadSession as boolean | undefined,
            mcpCapabilities: caps.mcpCapabilities as Record<string, unknown> | undefined,
            promptCapabilities: caps.promptCapabilities as Record<string, unknown> | undefined,
            sessionCapabilities: caps.sessionCapabilities as Record<string, unknown> | undefined,
          }
        : null;
      state.sessionState.promptCapabilities = (caps?.promptCapabilities as Record<string, unknown> | null) ?? null;
      state.dispatcher = new AcpDispatcher(state.sessionState, {
        send,
        workspace: state.workspace,
        onPermissionOutcome: resolvePermissionOutcome,
      });

      console.log(`[ccb-handler] started: ${instanceId}`);
      return { capabilities };
    },

    async stopInstance(state) {
      if (state.process && !state.process.killed) {
        state.process.kill("SIGTERM");
      }
    },
  };
}
