import type { EnginePlugin } from "@fenix/plugin-sdk";
import { AcpLinkProcessManager } from "./process/acp-link-process-manager";
import { createPortAllocator } from "./process/port-allocator";
import { createRelayHandle } from "./relay/relay-handle";
import { createCcbRuntime } from "./runtime/ccb-runtime";

export interface CcbPluginOptions {
  command?: string;
  args?: string[];
}

/**
 * 为兼容 CCB 工作区和 ACP 协议的引擎创建 runtime。
 * 调用方必须提供自己的引擎命令；此函数不承担引擎身份与默认值决策。
 */
export function createCcbCompatibleRuntime(options: Required<CcbPluginOptions>) {
  const { command, args } = options;
  return createCcbRuntime({
    portAllocator: createPortAllocator(),
    processManager: new AcpLinkProcessManager({ command, args }),
    createRelayHandle,
    relayHandleDependencies: {
      createWebSocket: (url) => new WebSocket(url) as never,
    },
  });
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
      return createCcbCompatibleRuntime({ command, args });
    },
  };
}
