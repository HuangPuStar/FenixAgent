import { createCoreRuntime, type CoreRuntimeFacade } from "@mothership/core";
import type { EngineRuntime } from "@mothership/plugin-sdk";
import { createEnginePlugin, type OpencodeRuntime } from "@mothership/opencode";

let facade: CoreRuntimeFacade | null = null;

/**
 * 获取全局 CoreRuntimeFacade 单例。
 * 首次调用时初始化：注册 opencode plugin + local node + onInstanceStarted 回调。
 *
 * 更换引擎时只需修改此文件：替换 plugin 和 onInstanceStarted 回调，
 * instance.ts 和 relay handler 层无需改动。
 */
export function getCoreRuntime(): CoreRuntimeFacade {
  if (!facade) {
    facade = createCoreRuntime({
      plugins: [createEnginePlugin()],
      nodes: [
        {
          id: "local-default",
          mode: "local",
          engineTypes: ["opencode"],
          status: "online",
        },
      ],
      onInstanceStarted(instanceId, runtime, updateMetadata) {
        const opencode = runtime as OpencodeRuntime;
        const state = opencode.getInstanceState(instanceId);
        if (state) {
          updateMetadata({
            port: state.port ?? 0,
            token: state.token ?? "",
          });
        }
      },
    });
  }
  return facade;
}

/** 重置单例（仅用于测试）。 */
export function resetCoreRuntime(): void {
  facade = null;
}
