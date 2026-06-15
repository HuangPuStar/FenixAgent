import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { ClaudeAgentSpawner } from "./agent-spawner.js";
import type { BridgeModule, BridgeStartOptions } from "./bridge-module.js";
import { ProtocolAdapter } from "./protocol-adapter.js";
import { prepareClaudeWorkspace } from "./workspace-preparer.js";

interface InstanceState {
  sessionId: string;
  spawner: ClaudeAgentSpawner | null;
  adapter: ProtocolAdapter | null;
}

/**
 * 创建 claude-bridge 模块实例。
 * 实现 BridgeModule 接口，封装 Claude Code 的 ACP 桥接逻辑。
 * 在 acp-link 进程内运行，根据 engine_type 选择使用。
 */
export function createClaudeBridge(workspaceRoot: string): BridgeModule {
  const instances = new Map<string, InstanceState>();
  const bridgeListeners = new Map<string, Array<(sessionId: string, payload: unknown) => void>>();

  function emit(sessionId: string, type: string, payload?: unknown): void {
    for (const cb of bridgeListeners.get(type) ?? []) {
      cb(sessionId, payload);
    }
  }

  const bridge: BridgeModule = {
    async prepare(key, launchSpec) {
      await prepareClaudeWorkspace(workspaceRoot, "ask", launchSpec as AgentLaunchSpec);
      const stateKey = (key as string) || ((launchSpec as AgentLaunchSpec).environmentId ?? "default");
      instances.set(stateKey, { sessionId: "", spawner: null, adapter: null });
      console.log(`[claude-bridge] prepared: key=${stateKey}`);
    },

    async start(sessionId, options) {
      const send = (type: string, payload?: unknown) => emit(sessionId, type, payload);
      const adapter = new ProtocolAdapter(send);
      const spawner = new ClaudeAgentSpawner();

      const sdkStream = spawner.spawn({
        cwd: options.cwd ?? workspaceRoot,
        prompt: options.systemPrompt ?? "Hello",
        permissionMode: "default",
        allowedTools: [],
        mcpServers: {},
        maxTurns: 200,
        cliPath: process.env.CLAUDE_CODE_CLI_PATH,
      });

      // 消费 SDK 流式输出
      (async () => {
        for await (const message of sdkStream) {
          adapter.handleSdkOutput(message);
        }
        send("prompt_complete", { stopReason: "end_turn" });
      })().catch((err) => {
        console.error("[claude-bridge] stream error:", err);
        send("session_error", String(err));
      });

      send("status", { connected: true });
      send("session_created", { sessionId: `claude_${sessionId}` });

      const stateKey = sessionId;
      const state = instances.get(stateKey);
      if (state) {
        state.spawner = spawner;
        state.adapter = adapter;
      }

      console.log(`[claude-bridge] started: sessionId=${sessionId}`);
      return { capabilities: {} };
    },

    async sendData(sessionId, acpMessage) {
      const state = instances.get(sessionId);
      if (state?.adapter) {
        await state.adapter.handleAcpMessage(acpMessage as Record<string, unknown>);
        return true;
      }
      console.warn(`[claude-bridge] sendData: no adapter for ${sessionId}`);
      return false;
    },

    async stop(sessionId) {
      const state = instances.get(sessionId);
      if (!state) return;
      if (state.spawner) {
        state.spawner.cancel();
      }
      instances.delete(sessionId);
      console.log(`[claude-bridge] stopped: sessionId=${sessionId}`);
    },

    on(event, callback) {
      const arr = bridgeListeners.get(event) ?? [];
      arr.push(callback);
      bridgeListeners.set(event, arr);
    },
  };

  return bridge;
}
