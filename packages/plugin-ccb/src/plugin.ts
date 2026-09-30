import type { EnginePlugin } from "@fenix/plugin-sdk";
import { AcpLinkProcessManager } from "./process/acp-link-process-manager";
import { createPortAllocator } from "./process/port-allocator";
import { createRelayHandle } from "./relay/relay-handle";
import { createCcbRuntime } from "./runtime/ccb-runtime";

export interface CcbPluginOptions {
  command?: string;
  args?: string[];
  /** workspace 根目录，宿主本地执行装配点注入（`getAgentRuntimeConfig().workspaceRoot`）。 */
  workspaceRoot?: string;
}

/**
 * 创建 ccb engine plugin 的唯一公开入口。
 */
export function createEnginePlugin(options: CcbPluginOptions = {}): EnginePlugin {
  const command = options.command ?? "ccb";
  const args = options.args ?? ["--acp"];

  return {
    meta: {
      id: "ccb",
      displayName: `CCB Engine (${command} ${args.join(" ")})`,
      version: "0.1.0",
    },
    createRuntime() {
      return createCcbRuntime({
        workspaceRoot: options.workspaceRoot,
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
