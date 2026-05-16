import type { EnginePlugin } from "@mothership/plugin-sdk";
import { AcpLinkProcessManager } from "./process/acp-link-process-manager";
import { createPortAllocator } from "./process/port-allocator";
import { createRelayHandle } from "./relay/relay-handle";
import { createOpencodeRuntime } from "./runtime/opencode-runtime";

/**
 * 创建 opencode engine plugin 的唯一公开入口。
 */
export function createEnginePlugin(): EnginePlugin {
  return {
    meta: {
      id: "opencode",
      displayName: "OpenCode Engine",
      version: "0.1.0",
    },
    createRuntime() {
      return createOpencodeRuntime({
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
