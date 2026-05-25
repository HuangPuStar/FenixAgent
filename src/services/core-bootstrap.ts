import { type CoreRuntimeFacade, createCoreRuntime } from "@mothership/core";
import { createEnginePlugin, type OpencodeRuntime } from "@mothership/opencode";

let facade: CoreRuntimeFacade | null = null;

function defaultCreateFacade(): CoreRuntimeFacade {
  return createCoreRuntime({
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

/** 可替换的 facade 工厂（测试时注入 mock） */
let _facadeFactory: (() => CoreRuntimeFacade) | null = null;

/**
 * 获取全局 CoreRuntimeFacade 单例。
 * 首次调用时初始化：注册 opencode plugin + local node + onInstanceStarted 回调。
 *
 * 更换引擎时只需修改此文件：替换 plugin 和 onInstanceStarted 回调，
 * instance.ts 和 relay handler 层无需改动。
 */
export function getCoreRuntime(): CoreRuntimeFacade {
  if (!facade) {
    facade = _facadeFactory ? _facadeFactory() : defaultCreateFacade();
  }
  return facade;
}

/** 测试用：注入自定义 facade 工厂。传 null 恢复默认。 */
export function setCoreRuntimeFactory(fn: (() => CoreRuntimeFacade) | null) {
  _facadeFactory = fn;
  facade = null;
}

/** 重置单例（仅用于测试）。 */
export function resetCoreRuntime(): void {
  facade = null;
}
