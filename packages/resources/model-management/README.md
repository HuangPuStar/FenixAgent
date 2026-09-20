# @fenix/model-management

Provider / Model 资源聚合根与模型网关（凭据隔离、预算、用量、密钥管理）的唯一 owner。

## 职责

- **Provider / Model 聚合根**：`provider` 是本包唯一的授权资源类型（`src/server/access/provider-resource.ts`，决策 D6）：owner / admin 拿 create、update、delete，member 默认只有 read，`public` 只放大读范围、不提升写权限。Model 是 Provider 的子表，不注册独立资源、不建 owner 或 visibility，读写一律先对 Provider 授权（`src/server/facades/provider-facade.ts`）。
- **组合根**：`createModelManagementServerModule(deps)` 由宿主注入 `AccessControlModule` / `ResourceScopeStore` / `AuthorizedResourceQuery` / `IdentityDirectory`，产出一份实例集（`facade` / `service` / `models` / `repositories`）。`src/server/module-runtime.ts` 装入进程级装配结果：`getModelManagementModule()` 在未装配时直接报错，不静默退化成「资源不存在」。
- **仓储**：`repositories/provider-resource.ts`、`model-resource.ts`、`model-gateway-credential.ts`。受控读取只交出主表、归属列与业务条件，授权谓词、排序与分页由平台的 `AuthorizedResourceQuery` 编译进同一条 SQL；写路径不属授权范围，校验发生在 Facade。
- **模型网关**：`src/server/model-gateway/**` 负责 LiteLLM adapter、管理凭据与本地加密密钥、Agent 动态 Key 的签发与吊销、预算和用量聚合。管理凭证或加密密钥缺失时 `createModelGatewayRuntime` 返回 `null`：保留 Provider 初始化能力，Agent Key 与管理操作明确失败，不用空凭证启动、不落明文。
- **主体校验端口**：`src/server/ports/subject-verification.ts` 只声明「这个主体还能不能用这个 Agent」的窄契约，实现由宿主注入（`apps/server/src/services/model-gateway-subject-verification.ts`），本包不复制 `agent_config` 的授权判断。
- **Peri 任务详情**：`src/services/peri-task-detail-{service,store}.ts` 从 Session Doc 读取有界摘要（`createDeterministicRcsSessionId` 定位 Doc、`getPeriTasksMap` 取任务），不接受客户端 locator、不声称摘要是完整 transcript，归属差异一律以 404 隐藏。
- **HTTP 交付物**：`/api/models/providers/**`、`/api/system/model-gateway/*`、`/web/config/providers/**`、`/web/config/models/**`、`/web/model-gateway/:providerId/usage`。
- **浏览器交付物**：`src/index.ts`（当前也被 `exports["./web"]` 指向）导出 `web/api/*` 客户端、`ModelConfigDialog`、`ModelIcon`、`EmbeddingModelManager`、`AlgorithmsPage` 与纯函数工具；`web/pages/**` 持有网关总览、密钥管理面板、用量页与 Agent 模型页。

## 依赖边界

- 类别 `resources`；唯一装配依赖是 `agent-config`——证据（`src/server/model-gateway/runtime.ts` 值导入 `findAgentConfigNamesByIds`）以及不声明其它边的理由写在 `fenix.module.ts` 的文档注释里，此处不重复。
- 平台能力只经 `@fenix/platform-sdk` 的窄契约取得：`IdentityDirectory`、`AccessControlModule`、`ResourceScopeStore`、`AuthorizedResourceQuery`、`AppError` / `WebOkSchema` 等；不导入 `@fenix/identity/*`、`@fenix/access-control/*`、`@fenix/agent-runtime/*`。
- 网关协议经 `@fenix/model-gateway-sdk`（端口与错误类型）与 `@fenix/model-gateway-litellm`（唯一 adapter 实现）；`@fenix/logger` 仅用于错误日志。
- 跨包复用只走对方公开入口：`@fenix/agent-config/server`、`@fenix/chat-channel` 与其 `/server` 子路径、`@fenix/resource-sandbox/web`（仅浏览器侧复用 `MasterKeyGate` / `SearchableUsageFilter`）。

## 守卫由宿主注入

**本包尚未收敛到该形态**，这是本节要追踪的差异：五个路由文件都是 `export default app`，守卫由包内直接导入取得——`@server/plugins/auth` 的 `authGuardPlugin`（`src/routes/api/models.ts`、`src/server/routes/web/config/{models,providers}.ts`、`src/server/routes/web/model-gateway.ts`）与 `@server/plugins/system-api-auth` 的 `systemApiAuthPlugin`（`src/server/routes/api/system-model-gateway.ts`）。

必须改成「工厂 + 守卫注入」的原因与 sandbox 相同：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填；守卫必须与宿主的认证解析（含 `setTestAuth` 测试 seam 与组织上下文）是同一份实例，否则两份同名实例会被按 plugin `name` 去重，先构造的一方静默生效。

归属：路由工厂化与 `@server/**` 依赖清除同属阶段 2 §1.5 的宿主挂载（本包 W2 切片）；在此之前不再新增第二套装配路径。

## 配置与 DB

- 不读 `process.env`、不读 `.env`。网关配置统一经 `@server/config`（宿主 `apps/server/src/env.ts` 已校验）读取，且读取点都在 `createModelGatewayRuntime` 调用时：`modelGatewayAdminKey`、`modelGatewayCredentialEncryptionKey`、`modelGatewayBaseUrl`、`modelGatewayAdminUiUrl`、`modelGatewayPublicBaseUrl`、`modelGatewayType`、`modelGatewayDefaultUserBudgetUsd`、`modelGatewayDefaultBudgetDuration`。
- DB 句柄与表对象仍来自宿主：`import { db } from "@server/db"`，表来自 `@server/db/schema` 的 `provider` / `model` / `model_gateway_credential` / `agent_config`（台账 `apps-boundary`，owner 1.5，38 处 / 16 文件）。
- 本包自有表为 `provider`、`model`、`model_gateway_credential`；`agent_config` 只是系统路径的只读引用，其资源定义属 `@fenix/agent-config`。
- 网关凭据经 `model-gateway/credential-cipher.ts` 用本地密钥加密后落库；密钥、明文凭据出现在日志、错误响应或测试 fixture 中都视为缺陷。

## 边界外的已知项

- **没有 `web/index.ts`**：`package.json` 的 `"./web"` 与 `"."` 当前同指 `./src/index.ts`，是 §1.6 下沉前的临时目标；改指 `./web/index.ts` 与浏览器面收敛同批（W2 切片 / §1.6）。
- **路由不是工厂**：见上节，归 W2 切片 / §1.5 宿主挂载。
- **没有 `src/module.ts` 单例**：`fenix.module.ts` 因此不声明 `create`（模块组合根属 W2 切片）；当前宿主显式调用 `createModelManagementServerModule` + `installModelManagementModule`。
- **表定义仍在宿主**：`provider` / `model` / `model_gateway_credential` / `agent_config` 的 Drizzle 对象与 `db` 句柄都 import 自 `@server/db*`，迁出归 §1.7。
- **`web/` 文案未自持**：本包没有 `i18n/` 目录；页面经 `react-i18next` 使用宿主的 `models` 命名空间（`apps/web/src/i18n/locales/*/models.json`）与 `@fenix/resource-observer` 的 `observer` 命名空间，文案资源下沉归 §1.6。
- **`web/src/**` 是残留层级**：`web/src/pages/agent-panel/**` 只剩 `AlgorithmsPage` / `EmbeddingModelManager`，由 `src/index.ts` 直接 re-export，与 `web/pages/**` 并存；W2 下沉时收敛为一层。
- **`web/**` 仍引用宿主实现**：`@/components/ui`、`@/src/api`、`@/src/types` 等 `@/` 别名导入（台账 `web-package-not-to-app`，owner 1.6，85 处 / 23 文件）。
- **`@fenix/web-runtime` 已声明未使用**：`package.json` 有该 workspace 依赖，包内无任何导入；接入点应是 §1.6 的 WebShell 装配，接入前不删除也不扩用。
