import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import * as z from "zod/v4";
import { pluginPackageResource } from "./src/server/access/plugin-package-resource";

/**
 * 插件市场资源模块描述符。
 *
 * 受控资源「市场条目」的唯一 owner：一个插件 = 一个 NPM package，稳定身份是 `(source_id, package_name)`；
 * 一个插件版本 = 一个 exact version；元数据白名单快照在版本行上、发布后不可变。市场的元数据来源是**外部
 * npm 私有源**（部署级配置注入的 base URL 与 token），本模块只读取 packument 元数据并保存投影，
 * 不下载、不解压、不扫描 tarball。
 *
 * 装配面上的服务端交付物是 `@fenix/resource-plugin-market/server`：资源注册 `pluginPackageResource`、
 * 组合根 `createPluginMarketServerModule`，以及 `./server/runtime` 的
 * `installPluginMarketModule` / `getPluginMarketModule`。宿主经 registry 调用本 manifest 的 `create`，
 * 不另开一条接线。
 *
 * `dependsOn: []` 是实测结论，不是省略：本包 `src/**` 的 workspace 值导入只有 `@fenix/platform-sdk`
 * （契约与装配面）与包内自引用（`./src/server/access/plugin-package-resource.ts` 经
 * `@fenix/resource-plugin-market/db` 取表定义）——前者是基础模块，不属于「资源模块之间必须成套启用」的
 * 装配依赖；后者生成器按包名跳过。`db/schema.ts` 按外键目标导入 `@fenix/identity/db` 的 `user` 表对象，
 * 属迁移链层面的列对象来源而非运行期耦合（装配依赖校验只扫 `src/**`），故也不进 `dependsOn`，但
 * `package.json` 的 `dependencies` 必须声明 `@fenix/identity`。
 *
 * 声明 `accessControlBindings`：`pluginPackageResource.storage` 是本模块主表（`plugin_market_package`）
 * 的归属列声明，由 `access-control` 的工厂经 `ModuleFactoryContext.declarations` 汇总。这里静态导入资源
 * 注册文件是有意的取舍：绑定是值而不是类型，只能来自静态导出；代价是 registry 的加载图多了本包的资源
 * 注册（含 `./db` 的表定义），而消费 registry 的入口只有服务端的装配入口与宿主用例。本模块**不得**为
 * 这条边把 `access-control` 写进 `dependsOn`：授权模块要等声明齐全才能构造。
 *
 * 声明 `create`：指向 `src/module.ts` 的 `createPluginMarketModule(context)`，由 registry 注入装配声明并
 * 装入组合根产出的实例。工厂保持惰性——registry 会被大量位置导入，不能在索引层就把 Drizzle 与 Elysia
 * 拖进模块图；构造仍由 `src/server/module.ts` 唯一实现。
 *
 * 声明 `envDefinitions`（路线 A）：npm 私有源的五键——base URL / token / 超时 / 响应上限 / 来源标识。
 * 五个键的消费者只在本包 `src/server/**`（`npm-registry/service.ts` 经 `getPluginMarketConfig()` 构造客户端、
 * 发布路径写 `source_id`），宿主只负责投影（`bootstrap/module-configs.ts` 的 `"plugin-market"` 条目），
 * 因此按「键归唯一模块」的口径全部归本模块。声明只承担启动期校验与汇总，值仍由宿主手工投影。
 *
 * **五个键全部 optional 或带默认值，一个都不能 required**：`apps/server/src/__tests__/assembly-env.test.ts`
 * 用真实清单 + 只有两个必填项的输入跑装配，任何 required 声明都会让整条 CE 装配线在启动期失败。仓内
 * 既有口径也是「未配置 → 该能力整体不启用」（先例 `RCS_MODEL_GATEWAY_CREDENTIAL_ENCRYPTION_KEY`）。
 * 具体到本模块：`PLUGIN_MARKET_REGISTRY_URL` 无默认值、未配置即 undefined，此时**只有发布与预览路径**
 * 以 `REGISTRY_NOT_CONFIGURED` 失败，浏览既有快照完全不读私有源，不受影响。
 *
 * 声明 `contributions`：`/web/config/plugin-market/*` 的路由实例由本模块以惰性构造函数
 * `(host) => import("./src/server/assembly").then(...)` 给出，`slot: "web-config"` 指明挂宿主哪一面——
 * 路由路径是相对形式，前缀由宿主的聚合实例决定，「挂哪一面」只能由声明说清。惰性 import 与 `create` 同因：
 * registry 会被大量位置导入，不能在索引层就把 Elysia 拖进模块图。
 *
 * 只有这一条贡献：市场没有对外 `/api` 面，也没有自鉴权的内部协议入口（对比 mcp 的三条）。发布与下架是
 * 平台管理动作，只能经控制台会话发生，不能由持有 API Key 的外部系统发起。
 *
 * 声明 `web`：浏览器载荷的入口说明符字符串。`web.id` 是全局唯一键（生成器据此把 profile 的 `web` 列表
 * 映射回包），必须等于导航项 id；`contribution` 指向本包 `web/contribution.ts` 的导出，且
 * `package.json` 的 `exports` 必须同时声明 `./web/contribution`——生成器逐项校验说明符与出口的对应关系，
 * 只声明不导出会在构建期失败（`scripts/generate-web-contributions.ts`）。
 */
export const moduleManifest = {
  id: "plugin-market",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.plugin-market"],
  envDefinitions: [
    {
      moduleId: "plugin-market",
      key: "PLUGIN_MARKET_REGISTRY_URL",
      // 空串归一为 undefined（先例 knowledge 的 RAGFLOW_API_URL）：docker-compose 的 `${VAR:-}` 在 .env 未设置时
      // 透传的是空串而不是 undefined，不归一会让「未配置」变成「配置了一个空地址」。无 defaultValue——源地址没有
      // 可用的默认值，写死一个只会把「未配置」伪装成「配置好了但连不上」。
      schema: z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional()),
      secret: false,
      restartRequired: true,
      description:
        "npm 私有源的 base URL（必须 http/https，如 http://registry.internal:4873）。装配期由宿主投影为模块配置 " +
        "registryUrl（未配置或空串 → null），本包在发布与预览路径经 getPluginRegistryClient() 读取。**未配置时" +
        "只有发布/预览失败**（REGISTRY_NOT_CONFIGURED 503），浏览已发布的插件走本地快照、不读私有源。值在装配期" +
        "固化进模块配置，改值须重启进程。",
    },
    {
      moduleId: "plugin-market",
      key: "PLUGIN_MARKET_REGISTRY_TOKEN",
      // 形状对齐 workflow 的 RCS_WORKFLOW_HMAC_SECRET：空串归一为 undefined 而非原样保留，否则会撞上模块配置的
      // min(1) 把「未配置凭据」变成启动期拒绝启动。
      schema: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
      secret: true,
      restartRequired: true,
      description:
        "访问 npm 私有源的 Bearer 凭据（可选）。装配期由宿主投影为模块配置 registryToken（未配置或空串 → null），" +
        "非空时作为 `authorization: Bearer …` 随 packument 请求发出。同源重定向限制保证凭据不会外泄到别的 host。" +
        "密钥材料，禁止进日志、响应与错误文案。",
    },
    {
      moduleId: "plugin-market",
      key: "PLUGIN_MARKET_REGISTRY_TIMEOUT_MS",
      schema: z.coerce.number().int().positive().default(8000),
      defaultValue: 8000,
      secret: false,
      restartRequired: true,
      description:
        "私有源单次 HTTP 请求超时（毫秒，正整数）。装配期由宿主投影为模块配置 registryTimeoutMs。字符串数字经 " +
        "z.coerce 归一；非正整数在启动期即被拒绝。超时对调用方表现为 REGISTRY_UNAVAILABLE。",
    },
    {
      moduleId: "plugin-market",
      key: "PLUGIN_MARKET_REGISTRY_MAX_BYTES",
      schema: z.coerce.number().int().positive().default(4194304),
      defaultValue: 4194304,
      secret: false,
      restartRequired: true,
      description:
        "私有源响应的字节上限（默认 4 MiB）。装配期由宿主投影为模块配置 registryMaxBytes。响应体是流式读取并在" +
        "累计超过上限时立即取消——超限拒绝而不截断，否则预览到的内容与落库内容会不一致，metadataDigest 这条比对" +
        "凭据随之失效。",
    },
    {
      moduleId: "plugin-market",
      key: "PLUGIN_MARKET_SOURCE_ID",
      schema: z.string().min(1).default("npm"),
      defaultValue: "npm",
      secret: false,
      restartRequired: true,
      description:
        "来源标识，写入 plugin_market_package.source_id 并参与聚合根唯一键 (source_id, package_name)。装配期由宿主" +
        "投影为模块配置 sourceId。默认 npm：市场当前只有一个来源（HTTP 发现源不在本期范围），该列的存在使将来新增" +
        "来源不需要改聚合根主键。",
    },
  ],
  web: {
    id: "plugin-market",
    contribution: "@fenix/resource-plugin-market/web/contribution",
  },
  accessControlBindings: [pluginPackageResource.storage],
  contributions: [
    {
      id: "plugin-market.web-config",
      kind: "app-route",
      slot: "web-config",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createPluginMarketWebConfigRoutes(host)),
    },
  ],
  // 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Drizzle 与 Elysia 拖进模块图。
  create: (context) => import("./src/module").then((module) => module.createPluginMarketModule(context)),
} satisfies ModuleManifest;
