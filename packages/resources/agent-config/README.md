# @fenix/agent-config

Agent 配置资源行、关联绑定（Skill / MCP / 知识库 / 记忆）与站点应用（Site App）的 owner。本包目录是
`agent_config` 与 `agent_site_app` 两张表的读写方、`/web` 与 `/api` 协议面的实现方，以及 agent 编辑器
/ 站点页面的浏览器实现方。

## 定位与 owner

- **资源域**：`agent_config`（资源行 + 授权入口）与 `agent_site_app`（站点应用）。受控读取的授权谓词
  由注入的 `AccessControlModule` 编译，仓储不判断组织、角色与 `visibility`；资源注册在
  `src/server/access/agent-config-resource.ts`（member 默认只有 `read` / `use`）。
- **清单与组合根**：`fenix.module.ts` 的 `moduleManifest`（`id: "agent-config"`、`kind: "resource"`、
  `capabilities: ["resource.agent-config"]`、`create` 惰性），`create()` 指向 `src/module.ts` 的
  `createAgentConfigModule()`；进程级装配结果由 `src/server/runtime.ts` 持有，
  `createAgentConfigServerModule(deps)`（`src/server/module.ts`）是唯一组合实现，未装配即报错。
- **依赖方向**：`dependsOn: ["knowledge","mcp","memory","skill"]`——四条边都由 `src/**` 的值导入证明
  （绑定表分散在各自资源包），注释逐条列在 `fenix.module.ts`。反向边由消费方声明：machine、
  model-management、observer 导入本包入口，本包不写这些边。
- **边界守护**：`src/__tests__/agent-config-source-migration.test.ts` 静态扫描 `src`、`web`、
  `fenix.module.ts`（含用例）的 import/export 说明符，断言：非表定义的 `@server/*` 导入为零、web 面
  `@/` 别名为零、穿透包外的相对引用为零、`src` 内环境变量直读为零、跨包不深入对方 `src/**`。

## 服务端交付物

- **路由工厂**（`src/server/routes/**`，实测 8 个 `create*` 导出；统一为 `createXxxRoutes(deps)` 形态，
  守卫与认证由宿主注入）：
  - `/web/config/agents`：`createWebConfigAgentsRoutes`（`src/server/routes/web/config/agents.ts`）
  - `/web/agent-sites`：`createWebAgentSitesRoutes`（`src/server/routes/web/agent-sites.ts`）
  - `/web/sidebar-config`：`createWebSidebarConfigRoutes`（`src/server/routes/web/sidebar-config.ts`）
  - `/web/agent-generation`：`createWebAgentGenerationRoutes`（`src/server/routes/web/agent-generation.ts`）
  - `/api/agents`：`createApiAgentsRoutes`（`src/server/routes/api/agents.ts`）
  - 站点前端代理 `/web/site/deploy/:appId/*`：`createAgentSitesProxyRoutes` 与兼容层
    `createAgentSitesCompatRoutes`（`src/server/routes/agent-sites-proxy.ts`）
  - Agent ↔ Site 绑定子路由：`createAgentSiteAssociationRoutes`
    （`src/server/routes/web/agent-site-association-routes.ts`）
- **注入面**：`src/server/routes/dependencies.ts` 定义 `authGuardPlugin`（宿主会话守卫）与
  `authenticateRequest`（站点代理的请求级认证）的类型与注入形状；包内不再 import 宿主守卫实现。
- **领域与应用层**：`src/server/services/agent-config-service.ts`（领域服务，不接收 actor）、
  `src/server/facades/agent-config-facade.ts`（授权编排 + 停止实例 / 清理绑定 Environment / 重启实例）、
  `src/server/services/agent-associations.ts`（Skill / MCP / 知识库 / 记忆 / 站点五类绑定的统一门面）、
  `src/server/repositories/*`（资源行、编排域 `AgentConfigRepo` 的 PG 实现、站点应用）。
- **模块配置**：`src/server/config.ts` 经 `getModuleConfig("agent-config")` 读取，并用 zod `strictObject`
  校验四个字段（`hiddenSidebarTabs`、`agentSitesBaseUrl`、`agentSitesMasterKey`、`agentGenerationModel`）。
  包内不读运行环境变量，值由宿主装配阶段注入。
- **表定义**：8 个生产文件**真实 import** `@server/db/schema`（另有 2 个用例导入、1 个契约测试自身含该
  字符串），这是本包唯一允许的宿主导入（迁出归 §1.7）。复核：
  `grep -rl 'from "@server/db/schema"' packages/resources/agent-config/src --include='*.ts' | grep -v __tests__ | wc -l`
  → 8；按裸字符串统计为 9，第 9 处是 `src/server/db.ts` 的**文档注释**（不是导入），不计入。
- **测试基建**：`./server/testing` 提供 `createAgentConfigModuleConfig` /
  `initializeAgentConfigModuleConfig`（复位替身 + 以模块配置初始化应用基础设施，DB 句柄经转发代理）、
  Facade / Service / Associations / Identity 替身与模块替身装载器；未打桩的方法调用即失败。
- **exports**（`package.json`，实测）：`.`、`./module`、`./server`、`./web`、`./web/i18n`、
  `./server/testing`，以及 4 条过渡子路径 `./server/runtime`、`./server/system-prompt`、
  `./server/api-agent-schema`、`./server/config`（消费方见「边界残留」）。

## web 面与 i18n

- **唯一跨包 web 入口**：`web/index.ts`。从它出发的值导入图不含 `node:` 内建、`@server/*` 与宿主别名
  `@/`，由 `web/__tests__/agent-config-browser-surface.test.ts` 递归守护（含跨包递归与白名单说明）。
- 导出面覆盖实测消费方：task / prod-view 取 `agentApi`；model-management 的编辑器纯逻辑用例取
  `agent-editor-model` 的转换与校验 schema；宿主 `AgentSidebarConfig.tsx` 取 `sidebarConfigApi`、宿主
  `AgentSidebarTree.tsx` 取 `ensureMetaAgent`；workflow 的 `useMetaAgent` 已导出待其改指。
- **包根导出的 `AgentSidebarConfig` 目前零消费方**（实测）：宿主控制台消费的是它自己的本地副本
  `apps/web/src/pages/agent-panel/AgentSidebarConfig.tsx`（`AgentSidebar.tsx` 从 `./AgentSidebarConfig`
  取 `AgentSidebarQuickNav`），二者同源——均为 151 行，仅两处 import 不同（宿主版从包根取
  `sidebarConfigApi`、`NS` 走宿主别名 `@/src/i18n`；包内版反之）。该副本连同其余宿主↔包同源实现的移除
  归 §1.6（整体处置口径见 review 文档 §6.9 第 1 条：页面下沉后宿主副本自然消失），宿主侧文件不在本包可写范围。
- **页面与组件域**：`web/pages/agent-panel/**`（编辑器、`AgentSitesPage`、`agent-sites-catalog`、
  `AgentSidebarConfig`）、`web/components/agent-panel/**`（`SiteFrame` / `SiteTabsBar` /
  `MountSiteDialog` / `AgentSitesCard`）、`web/api/**`、`web/hooks/**`、`web/lib/**`。
- **i18n 自持**：`web/i18n/locales/{en,zh}/agents.json` 各 271 个键，两份键结构一致（实测比对，
  由 `web/__tests__/agent-i18n.test.ts` 与 `agent-config-browser-surface.test.ts` 守护）；命名空间由
  `web/i18n/namespace.ts` 给出（`AGENTS_NS`）。宿主在 i18n 初始化时经子路径
  `@fenix/agent-config/web/i18n` 取 `agentResources.en/zh` 注册——走子路径而不是 `./web` 根入口，避免把
  整棵编辑器页面图拉进首屏 bundle；未注册时 i18next 回退为 key 回显。

## 边界残留

- **表定义**：`@server/db/schema`（8 个生产文件真实 import；按裸字符串统计多出的第 9 处是
  `src/server/db.ts` 的文档注释，非导入）是本包与宿主的唯一持久化耦合，迁出归任务 1.7。复核命令见
  「服务端交付物」的表定义条。
- **过渡 exports 子路径**（消费方实测，收敛到包根归宿主侧改动）：`./server/system-prompt` 被
  `apps/server/src/config.ts`、`apps/server/src/env.ts` 与 `packages/agent-runtime` 的
  `launch-spec-builder.ts` 消费；`./server/config` 被宿主 `config-validators` 用例消费；
  `./server/runtime` 与 `./server/api-agent-schema` 分别由宿主装配与协议 schema 消费方使用。
- **宿主侧第二份实现（待宿主删除，非本包可写范围）**：
  `apps/web/src/lib/agent-node.ts`、`agent-utils.ts`、`agent-resource-access.ts`（与包内 `web/lib/*`
  同源、仅导入路径不同，消费方是尚未迁移的宿主页面 `AgentManagementPage` / `AgentSidebarTree` 与其 3 个
  宿主用例）；`apps/web/src/pages/agent-panel/AgentSidebarConfig.tsx`（同源副本，见「web 面与 i18n」一节）。
  **已删除**：`apps/web/src/i18n/locales/{en,zh}/agents.json`（键集曾与包内两份文件完全一致）——宿主
  `apps/web/src/i18n/index.ts` 已改经 `@fenix/agent-config/web/i18n` 子路径注册 `agentResources`，不再
  持有第二份字典，此项已不是残留；`apps/server/src/schemas/sidebar-config.schema.ts`（任务 1.5a 随 160 行
  无引用 barrel `schemas/index.ts` 一并删除）；`apps/server/src/services/config-utils.ts` 的
  `isValidResourceName`（与包内 `src/server/services/config/agent-config.ts:99` 的 `isValidAgentName`
  逐字符等价，生产引用已归零，任务 1.5c 与宿主 `round16-*` / `round22-*` 两条用例同批删除）。
- **宿主 `user_config` 的读写**不在本包：本包只声明 `UserAgentPreferencesPort`，读写随 `user_config` 表在
  任务 1.5c 归位 `@fenix/identity` 的 `src/repositories/user-config.ts`（`getUserConfig` /
  `setUserConfig`），由 `apps/server/src/services/resource-module-ports.ts` 适配成端口后注入
  （`/web/config/agents` 与 `/web/config/models` 共用同一张表，只留一组写入语义）。
- **删除优于兼容**：本包不保留旧路径的 re-export，也不双写；宿主侧残留项的删除与宿主挂载接线同批提交。

## 已知项

- **删除链路的实例清理覆盖不完整**：`AgentConfigFacade.remove` 经动态 import 调用 agent-runtime 的
  `stopInstancesForEnvironments`，其内部 `getCoreRuntime()` 直读宿主 `@server/services/core-bootstrap`，
  唯一接缝是宿主 `stubCoreBootstrap`——按 §6.2 该替身归属 agent-runtime 的 `/server/testing`（尚未就绪），
  包内因此只能覆盖「无绑定 Environment」的分支，见 `src/__tests__/agent-config-delete-stops-instances.test.ts`
  的接缝说明。清理链路本体已由 `packages/agent-runtime/src/__tests__/orchestration-instance-cleanup-isolation.test.ts`
  覆盖；Facade 接线的用例随 agent-runtime `/server/testing` 就绪后恢复（登记在共享补丁与待办清单）。
- **宿主侧启动同步的覆盖缺口**：`meta-agent` 的内置 Skill 启动编排（宿主 `apps/server/src/services/sync-builtin.ts`）
  原由本包的 `meta-agent` 用例覆盖，因宿主依赖被切出包内，其等价覆盖需在宿主侧补齐（随 W3）。
- **模块配置字段暂由宿主直接提供**（`moduleConfigs["agent-config"]`），未走模块 `envDefinitions`；
  声明、校验与 preflight 收敛归任务 1.7。
- **§1.3(3) 的后半段「生成已授权 LaunchSpec 再调 Runtime port」本任务未实现**：Facade 只覆盖 CRUD 与
  `restartInstances`（后者校验 `use` 动作，成员默认具备），不产出 LaunchSpec；agent 的启动/运行路径由
  `@fenix/agent-runtime` 自行读取 `agent_config` 构建启动输入（`orchestration-bootstrap.ts` 经
  `agentConfigRepo`、`launch-spec-builder.ts` 直读表），**不经 ActorContext、不校验 `use` 动作**。
  影响面：启动期授权未经过本包 Facade，agent 配置读取尚未收敛为窄契约。该项归 **§1.4**
  （架构台账 `agent-runtime-not-to-resources` 的 `@fenix/agent-runtime → @fenix/agent-config` 条目 owner
  已是 1.4）。移除条件：`removeWhen` =「agent 配置读取收敛为 port 注入」——agent-runtime 改为经 Runtime
  port 接收已授权的启动输入后，本包 Facade 补上 `use` 授权与 LaunchSpec 生成，本条目同批删除。
- **（2026-09-20 复核已解除）本包 web 面在 `bun test` 中的求值失败，原因为宿主 i18n 旧深链**：宿主
  `apps/web/src/i18n/index.ts` 原先按各包旧布局深链 `web/i18n/{en,zh}/*.json`，经 `@fenix/identity/web`
  的 `OrgContext.tsx`（走宿主别名 `@/src/i18n`）把失效路径拉进本包值导入图，令 `@fenix/agent-config/web`
  在无 DOM 的 `bun test` 进程里 import 期即 `Cannot find module`。宿主改经 `@fenix/<pkg>/web/i18n` 子路径
  登记后该链已恢复：实测消费方用例
  `packages/resources/model-management/web/src/__tests__/agent-editor-model.test.ts` 13 pass / 0 fail
  （该文件头部记录了同一结论）。仅存的深链是 `@fenix/identity` 的 `apikey` / `orgs` 字典（纯 JSON 相对
  导入，可正常求值），属该包的 i18n 出口债（review 文档 §6.9 第 4 条），不构成本包阻塞。
- **包内不装配 access-control / identity**：`createAgentConfigModule()` 返回已装入的装配结果入口，
  由宿主注入授权与身份目录；registry 装配落地时应改为从 `context.modules` 取实例（§1.5）。
