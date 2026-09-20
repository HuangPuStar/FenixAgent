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
 * - `agent-runtime` 同样是值导入（`@fenix/agent-runtime/server` 的 `environmentRepo` / `agentInstanceRepo` /
 *   `listAcpConnections` / `listExternalRelayEntries`，以及延迟加载的 `getChatChannelController`），但它是
 *   `agent-runtime` 类别的基础模块，在 profile 里是固定槽位（`requireFoundation(profile.agentRuntime)`
 *   总是启用），不进入资源模块的装配依赖校验范围；跨类别边由 §2.3 矩阵与架构台账负责（owner 1.4）。
 * - `resource-sandbox` 只被 `web/**` 引用（`MasterKeyGate`、`mergeFlatRows` 等控制台组件），web 贡献
 *   不进入服务端装配顺序，其启用由 profile 的 `web` 列表表达（§1.6）；写进 `dependsOn` 等于凭空声明
 *   一条服务端不具备的边。
 * - `@fenix/platform-sdk` 与 `@fenix/logger` 是契约与工具包，不是模块，没有模块 ID 可声明。
 * - `@server/config`、`@server/db`、`@server/db/schema`、`@server/plugins/system-api-auth`、
 *   `@server/types/store` 是宿主内部路径（`apps-boundary` 台账条目，owner 1.5，其中表定义迁出归 §1.7），
 *   必须消除而不是编码成装配依赖——台账本身受「不再违规即删除」校验，无法用来长期豁免。
 *
 * 不声明 `create`：模块组合根（`src/module.ts` 的进程级单例）属任务 1.3 W2 切片。不声明
 * `contributions` / `web` / `envDefinitions`：前两者的消费方分别是 §1.5 的宿主挂载与 §1.6 的 WebShell
 * 装配，形状必须与消费端同时定型；`envDefinitions` 的宿主登记归 §1.7。
 */
export const moduleManifest = {
  id: "observer",
  kind: "resource",
  dependsOn: ["agent-config", "machine"],
  capabilities: ["resource.observer"],
} satisfies ModuleManifest;
