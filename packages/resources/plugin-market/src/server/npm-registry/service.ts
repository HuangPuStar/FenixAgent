import { getPluginMarketConfig } from "../config";
import { PluginMarketError } from "../errors";
import { type FetchLike, PluginRegistryClient } from "./client";

/** 装配覆盖项。生产只走 `getPluginRegistryClient()` 的默认调用，宿主不传任何覆盖。 */
export interface PluginRegistryClientOverrides {
  /**
   * 传输实现覆盖。
   *
   * 存在的唯一原因是**测试进程是共享的**：本仓库 `bun test` 把所有测试文件放进同一个进程，而多个测试文件会
   * 替换 `globalThis.fetch`（未必恢复）。需要真实 HTTP 的用例若不自带传输，它锁定的「配置 → 客户端 → 请求」
   * 这条接线就会随别的文件的执行顺序时绿时红。有了这个入口，接线的用例仍走真实 socket，却不读进程全局。
   */
  readonly fetchImpl?: FetchLike;
}

/**
 * 按模块配置构造私有源客户端。
 *
 * 「未配置源地址」在这里、也**只在这里**失败：市场浏览既有快照走的是本地表，与私有源是否配置无关；只有
 * 发布与预览两条路径需要读源。把失败点收在这一处，使「部署未配置」表现为一个可辨识的错误码
 * （`REGISTRY_NOT_CONFIGURED`），而不是让整条市场链路在启动期就崩掉。
 *
 * 不做缓存：客户端不持有业务状态，构造它只是一次字段拷贝。缓存反而会把启动期配置固化进进程，
 * 与「句柄在使用点取」的仓内口径相悖。
 *
 * 源地址去尾斜杠的归一留在客户端构造里（`client.ts`），此处不叠加第二份判定。
 */
export function getPluginRegistryClient(overrides: PluginRegistryClientOverrides = {}): PluginRegistryClient {
  const config = getPluginMarketConfig();
  if (!config.registryUrl) {
    throw new PluginMarketError(
      "REGISTRY_NOT_CONFIGURED",
      "未配置 npm 私有源地址（PLUGIN_MARKET_REGISTRY_URL），无法读取包元数据；浏览已发布的插件不受影响",
    );
  }
  return new PluginRegistryClient({
    baseUrl: config.registryUrl,
    token: config.registryToken,
    timeoutMs: config.registryTimeoutMs,
    maxBytes: config.registryMaxBytes,
    fetchImpl: overrides.fetchImpl,
  });
}
