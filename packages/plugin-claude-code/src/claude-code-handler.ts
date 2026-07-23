import * as acp from "@agentclientprotocol/sdk";
import {
  buildSettings as buildClaudeCodeSettings,
  buildMcpConfig,
  installSkills as installClaudeCodeSkills,
  writeSettings as writeClaudeCodeSettings,
} from "@fenix/claude-code";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { AcpDispatcher } from "acp-link/acp-dispatcher";
import { createClaudeAcpConnection } from "acp-link/client/claude-acp-adapter";
import type { EngineHandler, EngineStartContext } from "acp-link/client/instance-manager";

/**
 * Claude Code 引擎 handler：SDK query() 方式，不 spawn 子进程。
 */
export function createClaudeCodeHandler(): EngineHandler {
  return {
    async prepareWorkspace(workspace: string, launchSpec: AgentLaunchSpec): Promise<void> {
      const installedSkills = await installClaudeCodeSkills(workspace, launchSpec.skills);
      const runtimeConfig = buildClaudeCodeSettings(launchSpec, installedSkills);
      await writeClaudeCodeSettings(workspace, runtimeConfig);

      const mcpConfig = buildMcpConfig(launchSpec);
      if (mcpConfig) {
        const { writeMcpConfig } = await import("@fenix/claude-code");
        await writeMcpConfig(workspace, mcpConfig);
        console.log(`[claude-code-handler] wrote .mcp.json with ${Object.keys(mcpConfig.mcpServers).length} servers`);
      }

      if (launchSpec.agent.prompt) {
        const { writeClaudeMd } = await import("@fenix/claude-code");
        await writeClaudeMd(workspace, launchSpec.agent.prompt);
        console.log("[claude-code-handler] wrote CLAUDE.md");
      }
    },

    async startInstance(ctx: EngineStartContext) {
      const { state, instanceId, send } = ctx;
      const ccModel = state.launchSpec?.model?.model;
      const ccModelName = state.launchSpec?.model?.modelName;

      const connection = createClaudeAcpConnection(
        state.workspace,
        instanceId,
        send,
        state.launchSpec?.agent?.prompt,
        ccModelName ?? ccModel,
      );

      const initResult = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: "rcs-remote", version: "1.0.0" },
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });

      state.connection = connection;
      state.capabilities = (initResult.agentCapabilities as Record<string, unknown>) ?? {};
      state.sessionState.connection = connection;
      state.sessionState.agentCapabilities = initResult.agentCapabilities
        ? {
            _meta: initResult.agentCapabilities._meta,
            loadSession: initResult.agentCapabilities.loadSession,
            mcpCapabilities: initResult.agentCapabilities.mcpCapabilities,
            promptCapabilities: initResult.agentCapabilities.promptCapabilities,
            sessionCapabilities: initResult.agentCapabilities.sessionCapabilities,
          }
        : null;
      state.sessionState.promptCapabilities = initResult.agentCapabilities?.promptCapabilities ?? null;

      const ccConn = connection as unknown as Record<string, unknown>;
      const onControlResponse = ccConn.handleControlResponse as
        | ((requestId: string, approved: boolean, extra?: Record<string, unknown>) => void)
        | undefined;
      state.dispatcher = new AcpDispatcher(state.sessionState, {
        send,
        workspace: state.workspace,
        onControlResponse: onControlResponse
          ? (requestId, approved, extra) => onControlResponse(requestId, approved, extra)
          : undefined,
      });

      console.log(`[claude-code-handler] started: ${instanceId}`);
      return { capabilities: state.capabilities };
    },
  };
}
