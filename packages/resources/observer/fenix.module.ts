import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";

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
 * - `agent-config`：两处值导入。`src/server/services/observer/observer-service.ts` 导入
 *   `@fenix/agent-config/server` 的 `getAgentConfigById` 与 `findAgentConfigNamesByIds`——前者是
 *   machine 解析链 `environment.agentConfigId → agentConfig.machineId` 的一环（`resolveHostMachineId`），
 *   后者把 `agentConfigId` 角色解析为可读名称；`src/server/services/system-people-tree-service.ts`
 *   导入同出口的 `listAgentConfigsByOrganization` 与 `AgentConfigOwnershipRow`（1.7 B7 起人员树的
 *   `agent_config` 取数由「本包直读表」改为「owner 的组织维度只读列举」）。
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
 * - `resource-sandbox` 只被 `web/**` 引用（`mergeFlatRows` / `machineReverseIndex` / `integrityRows` 等
 *   observer 视图工具的寄居地，`AdminObserverPage` 与 4 个展示组件消费），web 贡献
 *   不进入服务端装配顺序，其启用由 profile 的 `web` 列表表达（§1.6）；写进 `dependsOn` 等于凭空声明
 *   一条服务端不具备的边。三个 admin 页面原先还取该包的 `MasterKeyGate`，该门 2026-09-22 下沉为
 *   `@fenix/ui-components/config/AdminKeyGate` + `@fenix/web-runtime/hooks/use-admin-key-gate`，
 *   `AdminLogsPage` / `AdminPeoplePage` 已完全不依赖沙盒包。
 * - `@fenix/platform-sdk` 与 `@fenix/logger` 是契约与工具包，不是模块，没有模块 ID 可声明。
 * - 宿主内部路径（`@server/**`）必须消除而不是编码成装配依赖——台账受「不再违规即删除」校验，
 *   无法用来长期豁免。W2 切片已把 `@server/plugins/system-api-auth` 改为路由工厂注入（守卫由宿主传入）、
 *   `@server/db` 改为 `@fenix/platform-sdk/server` 的 `getDatabase()`、`@server/config` 与
 *   `@server/types/store` 的用法改为平台契约或包内结构类型；最后一个命中是 `@server/db/schema`
 *   表定义（1 处 / 1 个文件），已随 1.7 B7 消失——人员树的 `agent_config` 读取收敛回 owner
 *   （`@fenix/agent-config/server` 的 `listAgentConfigsByOrganization()`），句柄层 `src/server/db.ts`
 *   与仓储 `src/server/repositories/system-people-repository.ts` 因此失去消费方、随实现一并删除。
 *   本包 `@server/**` 导入现已归零（实测 `grep -rn 'from "@server' src web fenix.module.ts | grep -v __tests__`
 *   → 0 条），`apps-boundary` 台账条目同批删除。
 *
 * 声明 `contributions`（1.5f）：三条只读接口的路由实例由本模块以惰性构造函数
 * `(host) => import("./src/server/assembly").then(...)` 给出，三者都挂宿主 `api` 聚合槽——路由路径自带
 * `/api/system/*` 前缀（对外合同的一部分），前缀不由宿主拼接。本包此前没有 `assembly.ts`：三条路由的守卫
 * 一直由宿主手写注入，1.5f 迁入贡献面时才需要这个收窄点。惰性 import 与 `create` 同因：registry 会被大量
 * 位置导入，不能在索引层就把 Elysia 拖进模块图。
 *
 * 不声明 `web` / `envDefinitions`：前者的消费方是 §1.6 的 WebShell 装配，形状必须与消费端同时定型；
 * `envDefinitions` 的宿主登记归 §1.7。
 */
export const moduleManifest = {
  id: "observer",
  kind: "resource",
  dependsOn: ["agent-config", "machine"],
  capabilities: ["resource.observer"],
  contributions: [
    {
      id: "observer.api-system-observer",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createObserverApiSystemRoutes(host)),
    },
    {
      id: "observer.api-system-logs",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createObserverApiSystemLogsRoutes(host)),
    },
    {
      id: "observer.api-system-people-tree",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createObserverApiSystemPeopleTreeRoutes(host)),
    },
  ],
  // 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Elysia、Drizzle 与各来源实现拖进模块图。
  create: () => import("./src/module").then((module) => module.createObserverModule()),
} satisfies ModuleManifest;
