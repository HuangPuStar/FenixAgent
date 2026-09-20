import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * Observer 资源模块描述符。
 *
 * 运行中 ACP 链接的只读观察面、系统日志检索与系统级人员树的唯一 owner。服务端交付物是三个系统级
 * 只读接口——`/api/system/observer/acp-link`（`ObserverService.tree()` 现场聚合 acp-ws /
 * external-relay / chat-relay 三来源并组装归属树）、`/api/system/logs`（日志文件列举、检索与流式
 * 下载）、`/api/system/people-tree`（组织 → 成员 → 智能体配置）。三者均受 system API Key 保护、
 * 请求驱动、即用即弃，不挂生命周期事件也不写库。装配面上的消费者是宿主 `apps/server`（挂载上述路由）。
 *
 * `dependsOn: ["agent-config","machine"]`：两条边都是 `src/**` 的静态值导入，方向与 §2.3 依赖矩阵一致。
 *
 * - `agent-config`：`src/server/services/observer/observer-service.ts` 导入 `@fenix/agent-config/server`
 *   的 `getAgentConfigById` 与 `findAgentConfigNamesByIds`——前者是 machine 解析链
 *   `environment.agentConfigId → agentConfig.machineId` 的一环（`resolveHostMachineId`），后者把
 *   `agentConfigId` 角色解析为可读名称。
 * - `machine`：同一个文件导入 `@fenix/resource-machine/server` 的 `findMachineNamesByIds`，为
 *   `machineId` 角色提供展示名称；缺名时前端回退显示原始 id，因此该依赖只影响展示层，不参与采集。
 *
 * 不声明其它反向边，逐条对应一种「不构成装配依赖」的形态：
 *
 * - `agent-runtime` 同样是值导入，但只经 `@fenix/agent-runtime/runtime` 的 `getBoundAgentRuntime()`
 *   取只读观测面（`observe.listAcpConnections` / `listExternalRelayConnections` / `listChatClients` /
 *   `getInstanceName` / `getEnvironmentRecord`）：1.4 W6b 之前这里直取 `@fenix/agent-runtime/server` 的
 *   环境与实例仓储、连接表 getter 与延迟加载的 chat 控制器，现在这些取数全部收敛进运行 port。
 *   agent-runtime 是 `agent-runtime` 类别的基础模块，在 profile 里是固定槽位
 *   （`requireFoundation(profile.agentRuntime)` 总是启用），不进入资源模块的装配依赖校验范围；
 *   跨类别边由 §2.3 矩阵与架构台账负责（owner 1.4）。
 * - `resource-sandbox` 只被 `web/**` 引用（`MasterKeyGate`、`mergeFlatRows` 等控制台组件），web 贡献
 *   不进入服务端装配顺序，其启用由 profile 的 `web` 列表表达（§1.6）；写进 `dependsOn` 等于凭空声明
 *   一条服务端不具备的边。
 * - `@fenix/platform-sdk` 与 `@fenix/logger` 是契约与工具包，不是模块，没有模块 ID 可声明。
 * - 宿主内部路径（`@server/**`）必须消除而不是编码成装配依赖——台账受「不再违规即删除」校验，
 *   无法用来长期豁免。W2 切片已把 `@server/plugins/system-api-auth` 改为路由工厂注入（守卫由宿主传入）、
 *   `@server/db` 改为 `@fenix/platform-sdk/server` 的 `getDatabase()`、`@server/config` 与
 *   `@server/types/store` 的用法改为平台契约或包内结构类型；剩余唯一命中是 `@server/db/schema`
 *   表定义（1 处 / 1 个文件，迁移归 §1.7，台账 owner 改 1.7）。
 *
 * 不声明 `contributions` / `web` / `envDefinitions`：前两者的消费方分别是 §1.5 的宿主挂载与 §1.6 的
 * WebShell 装配，形状必须与消费端同时定型；`envDefinitions` 的宿主登记归 §1.7。
 */
export const moduleManifest = {
  id: "observer",
  kind: "resource",
  dependsOn: ["agent-config", "machine"],
  capabilities: ["resource.observer"],
  // 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Elysia、Drizzle 与各来源实现拖进模块图。
  create: () => import("./src/module").then((module) => module.createObserverModule()),
} satisfies ModuleManifest;
