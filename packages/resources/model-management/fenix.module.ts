import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * Provider / Model 资源模块描述符。
 *
 * Provider / Model 资源聚合根与模型网关（凭据隔离、预算、用量、密钥管理）的唯一 owner。装配面上的
 * 消费者是宿主 `apps/server`：`main.ts` 用 `createModelGatewayRuntime` 装配网关运行时，并挂载
 * `/api/models` 与 `/api/system/model-gateway`；`routes/web/index.ts`、`routes/web/config/index.ts`
 * 分别挂载 `/web/model-gateway`、`/web/config/providers`、`/web/config/models`。
 *
 * `dependsOn: ["agent-config"]`：`src/server/model-gateway/runtime.ts` 值导入
 * `@fenix/agent-config/server` 的 `findAgentConfigNamesByIds`，把网关凭据映射里的 `agentConfigId`
 * 解析成 Agent 名称（用量列表与密钥管理列表两处都要用），两者必须成套启用。
 *
 * 不声明 `resource-sandbox`：只有 `web/pages/admin/AdminModelGatewayPage.tsx` 值导入
 * `@fenix/resource-sandbox/web` 复用 `MasterKeyGate` / `SearchableUsageFilter`，本包 `src/**` 无该
 * 导入；浏览器侧的模块依赖由装配 profile 的 web 列表表达（§1.6），不进入服务端装配顺序。
 * 不声明平台基础模块（`identity` / `access-control`）：它们在 profile 里是固定槽位，本包只经
 * `@fenix/platform-sdk` 的窄契约（`IdentityDirectory`、`AccessControlModule`）使用。
 * 不声明 `chat-channel`：`src/services/peri-task-detail-store.ts` 值导入它（Peri 任务详情读取
 * `DocManager` 与任务映射），但该包尚未提供 manifest、当前不在资源包装配集内；它注册为 resource
 * 模块的那一刻，生成器的装配依赖反向校验会强制补上这条边。
 *
 * 不声明 `create`：模块组合根（`src/module.ts` 的进程级单例）属任务 1.3 W2 切片；当前装配入口是
 * `createModelManagementServerModule` + `installModelManagementModule`（宿主显式调用）。
 * 不声明 `contributions` 与 `web`：消费方分别是 §1.5 的宿主挂载与 §1.6 的 WebShell 装配，形状必须与
 * 消费端同时定型；当前路由是包内 `.use(authGuardPlugin)` 的 default export，不形成第二套装配路径。
 */
export const moduleManifest = {
  id: "model-management",
  kind: "resource",
  dependsOn: ["agent-config"],
  capabilities: ["resource.model-management"],
} satisfies ModuleManifest;
