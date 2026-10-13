/**
 * 插件市场资源包服务端公开入口。
 *
 * 依赖方向：宿主 `apps/server` 是唯一合法消费者——它装配 `createPluginMarketModule`（经 registry）、
 * 读取 `getPluginMarketModule()` 的装配结果，并把 `/web/config/plugin-market/*` 挂在 `web-config` 槽上。
 * 本包不反向导入宿主，也不被其它资源包导入（市场是叶子模块，没有向外提供的展示投影）。
 *
 * 本入口不导出浏览器代码；浏览器载荷经 `@fenix/resource-plugin-market/web/contribution` 单独导出，
 * 避免服务端装配图被 React 依赖污染。
 *
 * `PluginMarketModuleConfig` 是唯一为**编译期检查**而导出的类型：宿主
 * `apps/server/src/bootstrap/module-configs.ts` 的投影是运行期无类型的 `Record<string, unknown>`，两侧字段
 * 名不一致不会有任何报错（只表现为请求期读不到配置）。宿主那条投影用例把它标注成期望值，字段改名即在
 * typecheck 期失败——不要因为「没有运行期引用」而删掉这个导出。
 */

export { PLUGIN_MARKET_PACKAGE_RESOURCE_TYPE, pluginPackageResource } from "./server/access/plugin-package-resource";
export { getPluginMarketConfig, type PluginMarketModuleConfig } from "./server/config";
export {
  createPluginMarketServerModule,
  type PluginMarketModuleDeps,
  type PluginMarketServerModule,
} from "./server/module";
export { getPluginMarketModule, installPluginMarketModule } from "./server/runtime";
