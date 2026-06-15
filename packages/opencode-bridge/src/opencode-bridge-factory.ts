import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { type SpawnResult, spawnOpencodeAgent } from "./agent-spawner.js";
import type { BridgeModule, BridgeStartOptions } from "./bridge-module.js";
import { SessionHandler } from "./session-handler.js";
import { type PreparedWorkspace, prepareWorkspace } from "./workspace-preparer.js";

interface InstanceState {
  sessionId: string;
  prepared: PreparedWorkspace | null;
  spawnResult: SpawnResult | null;
  sessionHandler: SessionHandler | null;
}

/**
 * 创建 opencode-bridge 模块实例。
 * 实现 BridgeModule 接口，封装 opencode 的 ACP 桥接逻辑。
 * 在 acp-link 进程内运行，根据 engine_type 选择使用。
 */
export function createOpencodeBridge(workspaceRoot: string, command = "opencode"): BridgeModule {
  const instances = new Map<string, InstanceState>();
  const bridgeListeners = new Map<string, Array<(sessionId: string, payload: unknown) => void>>();

  function emit(sessionId: string, type: string, payload?: unknown): void {
    for (const cb of bridgeListeners.get(type) ?? []) {
      cb(sessionId, payload);
    }
  }

  const bridge: BridgeModule = {
    async prepare(key, launchSpec) {
      const prepared = await prepareWorkspace(workspaceRoot, launchSpec);
      // 使用调用方传入的 key（instanceId），与 start(sessionId) 的 key 一致
      const stateKey = key as string;
      instances.set(stateKey || (launchSpec.environmentId ?? "default"), {
        sessionId: "",
        prepared,
        spawnResult: null,
        sessionHandler: null,
      });
      console.log(`[opencode-bridge] prepared: key=${stateKey} workspace=${prepared.workspace}`);
    },

    async start(sessionId, options) {
      const stateKey = sessionId;
      const state = instances.get(stateKey);
      if (!state?.prepared) {
        throw new Error(`Instance not prepared for session ${sessionId}`);
      }

      const spawnResult = await spawnOpencodeAgent({
        command,
        cwd: options.cwd ?? state.prepared.workspace,
        env: options.env,
      });

      spawnResult.process.on("exit", (code) => {
        console.log(`[opencode-bridge] opencode exited: sessionId=${sessionId}, code=${code}`);
        const s = instances.get(stateKey);
        if (s) {
          s.spawnResult = null;
          s.sessionHandler = null;
        }
      });

      const send = (type: string, payload?: unknown) => emit(sessionId, type, payload);

      const sessionHandler = new SessionHandler(
        spawnResult.connection,
        options.cwd ?? state.prepared.workspace,
        spawnResult.capabilities,
        send,
      );

      if (options.systemPrompt) {
        sessionHandler.setSystemPrompt(options.systemPrompt);
      }

      await sessionHandler.autoCreateSession(sessionId);

      state.spawnResult = spawnResult;
      state.sessionHandler = sessionHandler;
      console.log(`[opencode-bridge] started: sessionId=${sessionId}`);

      return { capabilities: spawnResult.capabilities };
    },

    async sendData(sessionId, acpMessage) {
      const state = instances.get(sessionId);
      if (state?.sessionHandler) {
        return state.sessionHandler.sendData(sessionId, acpMessage);
      }
      console.warn(`[opencode-bridge] sendData: no session handler for ${sessionId}`);
      return false;
    },

    async stop(sessionId) {
      const state = instances.get(sessionId);
      if (!state) return;
      if (state.spawnResult?.process && !state.spawnResult.process.killed) {
        state.spawnResult.process.kill("SIGTERM");
      }
      instances.delete(sessionId);
      console.log(`[opencode-bridge] stopped: sessionId=${sessionId}`);
    },

    on(event, callback) {
      const arr = bridgeListeners.get(event) ?? [];
      arr.push(callback);
      bridgeListeners.set(event, arr);
    },
  };

  return bridge;
}
