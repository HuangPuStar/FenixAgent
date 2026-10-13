import type { EnginePlugin } from "@fenix/plugin-sdk";
import { AcpLinkProcessManager } from "./process/acp-link-process-manager";
import { createPortAllocator } from "./process/port-allocator";
import { createRelayHandle } from "./relay/relay-handle";
import { createOpencodeRuntime } from "./runtime/opencode-runtime";

export interface OpencodePluginOptions {
  /** workspace 根目录，宿主本地执行装配点注入（`getAgentRuntimeConfig().workspaceRoot`）。 */
  workspaceRoot?: string;
}

/**
 * 创建 opencode engine plugin 的唯一公开入口。
 */
export function createEnginePlugin(options: OpencodePluginOptions = {}): EnginePlugin {
  return {
    meta: {
      id: "opencode",
      displayName: "OpenCode Engine",
      version: "0.1.0",
    },
    createRuntime() {
      return createOpencodeRuntime({
        workspaceRoot: options.workspaceRoot,
        portAllocator: createPortAllocator(),
        processManager: new AcpLinkProcessManager(),
        createRelayHandle,
        relayHandleDependencies: {
          createWebSocket: (url) => new WebSocket(url) as never,
        },
      });
    },
  };
}
