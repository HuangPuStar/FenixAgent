import type { EnginePlugin } from "@fenix/plugin-sdk";
import { AcpLinkProcessManager } from "./process/acp-link-process-manager";
import { createPortAllocator } from "./process/port-allocator";
import { createRelayHandle } from "./relay/relay-handle";
import { createCcbRuntime } from "./runtime/ccb-runtime";

/**
 * 创建 ccb (claude --acp) engine plugin 的唯一公开入口。
 */
export function createEnginePlugin(): EnginePlugin {
  return {
    meta: {
      id: "ccb",
      displayName: "CCB Engine (claude --acp)",
      version: "0.1.0",
    },
    createRuntime() {
      return createCcbRuntime({
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
