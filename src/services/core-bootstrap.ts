import { createCoreRuntime, type CoreRuntimeFacade } from "@mothership/core";
import type { EnginePlugin, EngineRuntime } from "@mothership/plugin-sdk";
import {
  createOpencodeRuntime,
  type OpencodeRuntime,
} from "@mothership/opencode";

export interface CoreRuntimeBundle {
  facade: CoreRuntimeFacade;
  opencodeRuntime: OpencodeRuntime;
}

let bundle: CoreRuntimeBundle | null = null;

/**
 * 包装共享的 OpencodeRuntime 实例为 EnginePlugin。
 * createRuntime() 始终返回同一个 runtime 实例，使 src 层能通过
 * opencodeRuntime.getInstanceState() 读取 port/token/pid。
 */
function createSharedOpencodePlugin(runtime: OpencodeRuntime): EnginePlugin {
  return {
    meta: {
      id: "opencode",
      displayName: "OpenCode Engine",
      version: "0.1.0",
    },
    createRuntime(): EngineRuntime {
      return runtime;
    },
  };
}

/**
 * 获取全局 CoreRuntimeBundle 单例。
 * 首次调用时初始化：注册 opencode plugin + local node。
 */
export function getCoreRuntime(): CoreRuntimeBundle {
  if (!bundle) {
    const opencodeRuntime = createOpencodeRuntime();
    const plugin = createSharedOpencodePlugin(opencodeRuntime);
    const facade = createCoreRuntime({
      plugins: [plugin],
      nodes: [
        {
          id: "local-default",
          mode: "local",
          engineTypes: ["opencode"],
          status: "online",
        },
      ],
    });
    bundle = { facade, opencodeRuntime };
  }
  return bundle;
}

/** 重置单例（仅用于测试）。 */
export function resetCoreRuntime(): void {
  bundle = null;
}
