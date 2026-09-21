# @fenix/resource-channel

IM 通道能力的唯一 owner：通道平台描述、Hermes 网关连接与消息匹配、通道绑定的领域规则，以及配套的 `/web/channels/*` 协议面、控制台页面与语言资源。

## 定位与 owner

- **本包拥有的领域**：通道平台清单与启用状态（`src/server/services/channel-provider.ts`）、Hermes 网关客户端（`services/hermes-client.ts`：连接、心跳、指数退避重连、平台订阅、入站消息分发、出站 `send`）、通道绑定 CRUD 与消息匹配规则（`services/channel-binding.ts`，精确 `chatId` 优先、`chatId === null` 通配其次）、`/web/channels/*` 的六个端点、控制台页面 `web/pages/agent-panel/pages/AgentChannelsPage.tsx` 与 `channels` 命名空间的语言资源。
- **数据面**：`channel_binding` 表上的规则与唯一数据访问点（`src/server/repositories/channel-binding.ts`）归本包；表定义本身仍在宿主（见「边界残留」）。
- **不属本包**：Environment 的归属查询归 `@fenix/agent-runtime`（本包只声明用到的三个字段）、会话认证守卫归宿主 `apps/server`、基础 UI 归 `@fenix/ui-components`、请求封装归 `@fenix/web-runtime`、身份与授权归 `@fenix/identity` / `@fenix/access-control`（本包不导入，组织隔离靠 Environment 归属比对实现）。
- **装配面**：`fenix.module.ts` 的 `id: "channel"` / `kind: "resource"` / `dependsOn: []` / `capabilities: ["resource.channel"]`；本包是叶子模块，不要求其它资源模块同批启用。

## 服务端交付物

入口 `@fenix/resource-channel/server`（`src/server.ts`）：

- **路由工厂** `createWebChannelsRoutes({ authGuardPlugin, environmentLookup })`，六个端点：`GET /channels/providers`、`GET /channels/hermes/status`、`GET|POST /channels/bindings`、`PATCH|DELETE /channels/bindings/:id`。全部声明 `sessionAuth: true`（包内用例逐端点断言未认证时返回 401）。守卫与 Environment 归属查询由宿主注入，理由见 `src/server/routes/dependencies.ts`：Elysia 的 `macro` / `state` 是实例作用域的，守卫必须与宿主的认证解析是同一份实例。
- **组织隔离语义**：列表只返回「绑定目标 Environment 属于调用者组织」的记录（隐藏越权数据），写操作对跨组织绑定返回 403、对不存在的绑定返回 404；响应中的环境名来自注入的 `environmentLookup`，不回显 Environment 的其余字段（含 `secret`）。
- **绑定领域服务** `listBindings` / `getBinding` / `createBinding` / `deleteBinding` / `updateBinding` / `findBindingForMessage`，以及 `src/server/schemas/channel.schema.ts` 的 zod 请求/响应模型（用 `@fenix/platform-sdk` 的 `WebOkSchema` / `WebErrSchema` 包装）。
- **Hermes 单例** `initHermesClient(url, options)` / `getHermesClient()` / `resetHermesClient()`；`HermesClientOptions.platforms` 是已部署配置值（逗号分隔），宿主在装配期从 `HERMES_PLATFORMS` 取来注入——本包不读环境变量，未给定时回落内置常见平台清单，显式给空表示不订阅任何平台（两种语义在用例中分别固定）。
- **ACP 事件总线端口** `bindAcpEventBusPort` / `getAcpEventBusPort` / `resetAcpEventBusPort`：出站回投的绑定点由宿主持有（`apps/server/src/main.ts`），未绑定时 `get` fail-fast，本包不反向导入 Machine。
- **组合根** `src/module.ts` 的 `createChannelModule()` 返回进程级单例入口（`hermesClient` / `acpEventBus`），`fenix.module.ts` 通过惰性 `create` 导入，避免 registry 索引把 Elysia 与 Hermes 客户端拖进模块图。
- **DB 句柄** `getChannelDatabase()`（`@fenix/platform-sdk/server` 的 `getDatabase()`），类型 `NodePgDatabase<Record<string, never>>`，不耦合宿主的 schema 聚合类型；句柄在每个方法内取，不在模块作用域缓存（宿主基础设施初始化前导入模块图是常态）。
- **宿主的接线要求**（本包不改 `apps/**`，待编排者同批落地）：`createWebChannelsRoutes({ authGuardPlugin, environmentLookup: environmentRepo })`、`initHermesClient(hermesUrl, { platforms: env.HERMES_PLATFORMS })`、`bindAcpEventBusPort(...)`。

## web 面与 i18n

入口 `@fenix/resource-channel/web`（`web/index.ts`）：

- 导出 `channelsResources` / `CHANNELS_NS` / 类型 `ChannelResources`、`channelApi` 与各响应类型、`AgentChannelsPage`。
- **依赖映射**（`@/` 别名计数为 0）：`@fenix/web-runtime/api/request` 的 `request` / `unwrap`、`@fenix/ui-components/{ui,config,layout,components}/*` 的基础组件、`@fenix/agent-runtime/web/api/environments` 的 `envApi`；包内相对引用只到 `../../../api/channels` 与 `../../../lib/channel-list-state`。`lucide-react`（错误态图标）与 `sonner`（toast）已在浏览器守卫的白名单里。
- **浏览器安全守卫**：`web/__tests__/channel-browser-surface.test.ts`（14 个用例）递归走 `web/index.ts` 的值导入图（跨包经对方 `exports` 解析），断言不出现 `node:` 内建、`@server/*`、宿主别名与 `@fenix/*/src`，并把外部依赖钉在白名单上；`web/__tests__/value-import-graph.ts` 是守卫工具（与 sandbox 的同名文件刻意各自持有一份——它属于测试设施，跨包共享会把两个包的测试互相锁死）。
- **i18n 归属**：键的 owner 是本包，JSON 落在 `web/i18n/locales/{en,zh}/channels.json`（各 40 个叶键，双语键集合一致）——任务 1.3 §4 的统一形状，对照 `packages/resources/sandbox/web/i18n/`；旧路径 `web/i18n/{en,zh}/` 已迁走。`web/i18n/index.ts` 相对导入两份字典并导出 `channelsResources`（`{ en, zh } as const`）、`CHANNELS_NS = "channels"` 与类型 `ChannelResources`，`web/i18n/namespace.ts` 只持 ns 常量（组件不该为 `useTranslation(CHANNELS_NS)` 把字典拉进模块图），`package.json` 的 `exports["./web/i18n"]` 指向 `web/i18n/index.ts`。`CHANNELS_NS` 必须与宿主 `NS.CHANNELS` 保持同一字面量（当前 `packages/web-runtime/web/i18n/namespace.ts:26` 的 `CHANNELS: "channels"`）。字典由两侧测试守护：`web/__tests__/channel-i18n.test.ts`（5 个用例，整个 `web/` 树：4 条与模板同形的结构性断言——键集一致、占位符一致、字面量 `t()` 键齐备、无 `channels.` 嵌套键——另加本包专属 1 条：下方「已知项」的无消费点键清单，即实测的 4→5）与 `web/__tests__/channel-i18n-contract.test.ts`（5 个用例，`AgentChannelsPage.tsx` 的 AST 契约：无动态键、可见属性无裸字符串）。
- **列表页的状态分支**：`web/lib/channel-list-state.ts` 是纯判定（无 React），把「加载中 / 无权限 / 一般失败 / 就绪」的优先级收在一处；页面按它分流。关键不变量：**请求失败必须落到持久错误态（`role="alert"`），不得退化成 `AgentCardList` 的「暂无绑定」空态**；无权限分支（401/403 在 request 层归一为 `UNAUTHORIZED`）不给重试按钮；已有数据后刷新失败保持列表可用（判据 `error && itemCount === 0`）。该规则的用例在 `web/__tests__/channel-list-state.test.ts`——本包 web 侧没有 DOM 测试设施（`package.json` 不含 happy-dom / testing-library），因此把规则抽成纯函数来断言，而不是对 JSX 做结构断言。
- **键迁移面**：包内只有 `AgentChannelsPage.tsx` 使用 `useTranslation("channels")`，两份 JSON 的键集合全部属于通道域，迁移（任务 1.3 W2）时与旧路径逐字节一致，因此没有键从宿主搬入、也没有键需要从宿主删除。此后的 §1.3(6) 缺口修复新增了 3 个键（`retry`、`unauthorized`、`unauthorizedHint`，用于列表的持久错误态与无权限分支），en/zh 同步新增、键集仍一致。

## 边界残留

- **表定义仍在宿主**：`@server/db/schema` 是本包唯一的宿主导入（1 处 / 1 个文件，`src/server/repositories/channel-binding.ts`），属任务 1.3 §1 静态条件 1 允许的残留，迁出归 §1.7；契约测试用白名单限定只能读到本包 owner 的 `channelBinding`，读别包的表会直接失败。
- **宿主接线**（本包不改 `apps/**`，登记给编排者；行号以编写时的 `grep -n` 复核，落盘时再复核一次）：
  - **已切换 — 服务端装配**：`apps/server/src/routes/web/index.ts:8` 取具名工厂、`:42` 为 `createWebChannelsRoutes({ authGuardPlugin, environmentLookup })`；`apps/server/src/main.ts:261` 已 `bindAcpEventBusPort({ getAcpBus })`、`:401` 已 `initHermesClient(hermesUrl, { platforms: env.HERMES_PLATFORMS })`；`apps/generated/module-registry.ts:8` 已含 `@fenix/resource-channel/module`。
  - **已切换 — 宿主 i18n 注册**（`apps/web/src/i18n/index.ts`，§4 共享文件）：`:15` 从子路径导入 `{ CHANNELS_NS, channelsResources }`（`@fenix/resource-channel/web/i18n`），`:121` / `:135` 按 `[CHANNELS_NS]` 登记 `channelsResources.en` / `.zh`。此前 README 记为「待落盘」且称宿主按相对路径 import 已删除的 `web/i18n/{en,zh}/channels.json`，与实测不符，已订正。宿主的 `NS.CHANNELS` 字面量仍是 `"channels"`（`packages/web-runtime/web/i18n/namespace.ts:26`），与包内 `CHANNELS_NS` 一致。
  - **§1.6 WebShell 收敛 — 页面部分已落地**：`apps/web/src/routes/agent/_panel/channels.tsx` 的懒加载说明符已随 T11e 改指 `@fenix/resource-channel/web`。宿主 `apps/web/vite.config.ts` 与根 tsconfig 中 `@/src/api/channels`、`@/src/pages/agent-panel/pages/AgentChannelsPage` 两条文件级 alias 已无消费方，并随 §1.6 T11e-4b 的别名表删除批次一并移除（2026-09-21 实测：`git grep -n '"@/src/api/channels"'`、`"@/src/pages/agent-panel/pages/AgentChannelsPage"` 均 0 命中）。宿主两份别名表（`apps/web/vite.config.ts`、根 `tsconfig.json`）现在只保留宿主自有别名（宿主 `src/`、宿主 i18n 字典、`@server`），本包 `./web` 出口是唯一公开面。
  - **待落盘 — CE 装配清单**：`deploy/assembly/ce.json` 的 `"resources": []` 需登记 `channel`（复核：`grep -n channel deploy/assembly/ce.json` 当前无命中）。
- **架构台账**（`scripts/architecture/exceptions.json`，编排者所有；W2.5 复测现状 = 已达标）：
  - `web-package-not-to-app`（channel）：entry 已从工作区文件删除（复测：`grep -n '@fenix/resource-channel'` 只剩 2 处——`handwrittenRegistryBaseline` 与 `apps-boundary` 条目，规则为 `web-package-not-to-app` 的 channel 条目不存在）。归零依据：`grep -rnE 'from "@/' packages/resources/channel/web` → 0 命中。**2026-09-21 更新：`handwrittenRegistryBaseline` 已随 1.5f 的 `main.ts` 切换整体删除，复测命中数随之减 1；不影响本条的归零结论。**
  - `apps-boundary`（channel，owner 1.7）：条目 rationale 已是「实测 1 处导入 / 1 个文件，全部为 `@server/db/schema` 表定义导入」，与复测一致（`grep -rnE 'from "@server/' packages/resources/channel/src` → 仅 `src/server/repositories/channel-binding.ts:1`）。若上游回退这两处削减，需按门禁规则重做（stale 条目与未登记违规都会直接失败）。
- **`im_channel` / `im_channel_route` 无实现**：宿主 `apps/server/src/db/schema.ts` 已声明这两个「升级目标」表，但除 schema 内部外没有任何代码引用；本包仍以遗留表 `channel_binding` 为数据面。补实现或删表都不在本任务范围，需先确认归属。

## 已知项

- **前后端 DTO 各写一份**：`web/api/channels.ts` 手写响应类型，`src/server/schemas/channel.schema.ts` 用 zod 描述同一形状，两者靠人工同步；契约测试目前只覆盖服务端 schema 与 web 面的静态形状，没有共享的真相来源。
- **列表接口的查询形状**：`GET /channels/bindings` 先取全量绑定再按组织的 Environment ID 过滤，并对每条命中绑定各查一次 Environment（N+1）。当前绑定数量下可接受；数量增长时应把组织过滤下推到 repository 查询，并与 Environment 名称的批量读取一起改。
- **平台清单是静态常量**（微信 / 飞书），`status` 由 Hermes 推送的 `platform_status` 推导：Hermes 未接入时全部为 `disabled`，这不代表平台能力缺失。
- **字典有 18 个当前没有消费点的键**（实测 40 个叶键中 22 个有消费点）：`hermes.*`（7）、`columns.*`（5）、`dialog.cancel` / `dialog.create` / `dialog.creating`（3）、`dialog.agentPlaceholder` / `dialog.chatIdPlaceholder`（2）、`updateBindingFailed`（1）。当前唯一消费方 `AgentChannelsPage.tsx` 用 `AgentCardList` 渲染，不渲染 Hermes 状态面板与表格列，而 `web/api/channels.ts` 仍导出 `hermesStatus()`；`updateBindingFailed` 与 `dialog.*Placeholder` 是迁移前遗留的键，本包没有「更新绑定状态」「选择平台/Agent 的占位提示」这两个交互。删除与否待 `GET /channels/hermes/status` 的展示点定型，避免删了又要恢复。
  - 计数口径与可复核命令（在 `packages/resources/channel` 下执行，输出即上面 18 个键）：
    ```bash
    comm -23 \
      <(jq -r 'paths(scalars) | join(".")' web/i18n/locales/en/channels.json | sort) \
      <(grep -rhoE 't\("[^"]+"' web --include='*.ts' --include='*.tsx' | sed -E 's/^t\("//; s/"$//' | sort -u)
    ```
    同一份清单已钉进 `web/__tests__/channel-i18n.test.ts`（用例「无消费点的键清单与 README 已知项一致」），避免两侧各记一份而漂移——本条 README 历史记录为 15 个，实测 20 个，漏记 `bindingDeleted`（本次已由删除成功提示消费）、`unknownError`、`updateBindingFailed`、`dialog.agentPlaceholder`、`dialog.chatIdPlaceholder`；`unknownError` 同时被一般错误分支消费，故本次订正后为 18。
- **入站投递失败只记日志**：`routeToAgent()` 找不到运行实例且 WS 投递失败时不重试、不排队（与迁移前一致）；要做投递保证必须先定幂等键与背压策略。
- **包内用例的覆盖边界**：守卫替身（`src/__tests__/guard-stubs.ts`）不解析 cookie / Environment Secret / API Key，只按宿主真实守卫的未认证形状（401 + `{ error: { type: "unauthorized" } }`）拒绝并写入 `store.authContext`；「路由 + 真实守卫 + 凭据优先级」这条已发布合同的覆盖归 §1.5 的宿主用例，本包不复制鉴权实现。
- **`setHermesClientGetter()` 仍是测试 seam**：`channel-provider.ts` 未从 `./server` 导出，平台清单目前只能经 `/web/channels/providers` 消费；等出现第二个消费方再定公开形状（不提前抽象）。
- **`src/index.ts` 根入口刻意为空**：浏览器面 / 服务端面 / 模块描述符各有明确入口，根入口 re-export 任一面都会把服务端实现拖进浏览器解析图；等 §1.6 的 WebShell 与 §1.5 的宿主装配定型后再定内容。
