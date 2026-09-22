import type { EnginePlugin } from "@fenix/plugin-sdk";
import { AcpLinkProcessManager } from "./process/acp-link-process-manager";
import { createPortAllocator } from "./process/port-allocator";
import { createRelayHandle } from "./relay/relay-handle";
import { createPeriRuntime } from "./runtime/peri-runtime";

export interface PeriPluginOptions {
  command?: string;
  args?: string[];
}

/**
 * 创建 peri engine plugin 的唯一公开入口。
 */
export function createEnginePlugin(options: PeriPluginOptions = {}): EnginePlugin {
  const command = options.command ?? "peri";
  const args = options.args ?? ["acp"];

  return {
    meta: {
      id: "peri",
      displayName: `Peri Engine (${command} ${args.join(" ")})`,
      version: "0.1.0",
    },
    createRuntime() {
      return createPeriRuntime({
        portAllocator: createPortAllocator(),
        processManager: new AcpLinkProcessManager({ command, args }),
        createRelayHandle,
        relayHandleDependencies: {
          createWebSocket: (url) => new WebSocket(url) as never,
        },
      });
    },
  };
}
