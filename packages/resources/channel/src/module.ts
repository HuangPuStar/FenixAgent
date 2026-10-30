import type { ModuleFactoryContext } from "@fenix/platform-sdk";
import { assertLangBotDataPlaneConfigured, getChannelConfig } from "./server/config";
import { type ChannelServerModule, createChannelServerModule } from "./server/module";
import { installChannelModule } from "./server/runtime";

/**
 * Channel 模块的 registry 装配入口（`fenix.module.ts` 的 `create` 目标）。
 *
 * 本模块没有装配期外部依赖：仓储经平台 DB 句柄在请求期取用，LangBot 客户端在调用期读模块配置，Agent
 * 配置可用性端口由宿主在启动流程里晚绑定。因此装配只构造实例并装入进程级槽位。
 *
 * 例外是配置的**完整性**：启用 LangBot 的部署缺数据面密钥时，全量消息都会失败且没有任何启动提示，
 * 因此在装配期直接拒绝启动（未配置 `LANGBOT_BASE_URL` 的部署不受影响）。
 *
 * 必须 `install`：路由经 `getChannelModule()` 读取同一份结果（唯一读取点）。cleanup 只释放数据面
 * dispatcher 的重试定时器与订阅表：定时器若随进程退出自然消失，测试与热重载下会留下跨实例的重复派发。
 */
export function createChannelModule(context?: Pick<ModuleFactoryContext, "registerCleanup">): ChannelServerModule {
  assertLangBotDataPlaneConfigured(getChannelConfig());
  const module = createChannelServerModule();
  installChannelModule(module);
  context?.registerCleanup(() => {
    module.dataPlane?.dispatcher.stop();
  });
  return module;
}
