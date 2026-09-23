# @fenix/agent-config

Agent 配置资源行、关联绑定（Skill / MCP / 知识库 / 记忆）与站点应用（Site App）的 owner。本包是
`agent_config`、三张关联表（`agent_config_skill` / `agent_config_mcp` / `agent_config_site_app`）与
`agent_site_app` 五张表的唯一 owner——表定义在 `db/schema.ts`，经出口 `@fenix/agent-config/db` 汇入
`drizzle.config.ts` 声明的同一条迁移链（任务 1.7 B7）——也是 `/web` 与 `/api` 协议面的实现方，以及
agent 编辑器 / 站点页面的浏览器实现方。

## 定位与 owner

- **资源域**：受控资源主表 `agent_config`（资源行 + 授权入口）与 `agent_site_app`（站点应用）。三张关联表
  （`agent_config_skill` / `agent_config_mcp` / `agent_config_site_app`）随聚合归本包：它们的
  `agent_config_id` 都指向本包主表，而 Drizzle 的 `.references()` 只接受列对象、没有字符串形式，任何非本包
  持有的关联表都必须组装期导入 `@fenix/agent-config/db`，因此留在聚合根内是零新边、零新环的方案。受控读取的
  授权谓词由注入的 `AccessControlModule` 编译，仓储不判断组织、角色与
  `visibility`；资源注册在 `src/server/access/agent-config-resource.ts`（member 默认只有 `read` / `use`）。
- **清单与组合根**：`fenix.module.ts` 的 `moduleManifest`（`id: "agent-config"`、`kind: "resource"`、
  `capabilities: ["resource.agent-config"]`、`create` 惰性），`create()` 指向 `src/module.ts` 的
  `createAgentConfigModule()`；进程级装配结果由 `src/server/runtime.ts` 持有，
  `createAgentConfigServerModule(deps)`（`src/server/module.ts`）是唯一组合实现，未装配即报错。
- **依赖方向**：`dependsOn: ["knowledge","mcp","memory","skill"]`——四条边都由 `src/**` 的值导入证明，
  注释逐条列在 `fenix.module.ts`。mcp / skill 两条在 B7 前由「绑定表归对方」支撑；关联表迁入本包后，来源改为
  纯取数面：对方的标签投影（`@fenix/resource-mcp/server/config` 与 `@fenix/resource-skill/server/config`）、
  LaunchSpec 解析里的对方 service / row 类型、Skill Facade 与内容能力。反向边由消费方声明：machine、
  model-management、observer 导入本包入口，本包不写这些边。
- **边界守护**：`src/__tests__/agent-config-source-migration.test.ts` 静态扫描 `src`、`web`、`db`、
  `fenix.module.ts`（含用例）的 import/export 说明符，断言：**任何** `@server/*` 导入为零（B9 起零容忍，
  见下条）、web 面 `@/` 别名为零、穿透包外的相对引用为零、`src` 内环境变量直读为零、跨包不深入对方
  `src/**`。原「非表定义的 `@server/*` 导入为零 + 白名单常量 `ALLOWED_HOST_IMPORT`」的写法随本包残留
  归零而收缩：白名单常量与「残留必然存在」的正向控制一并删除，正向控制改由扫描器负例夹具
  (`SCANNER_FIXTURE`，块注释形状，两半断言) 承担——此刻「扫不到宿主导入」才是正确结果，旧控制会把
  正确结果判成失效。`db/schema.ts` 与其它入口一样被钉在自检清单里，避免「本包确实零宿主导入」与
  「`db/` 根本没进扫描集」分不开。

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
  `src/server/services/agent-associations.ts`（Skill / MCP / 知识库 / 记忆 / 站点五类绑定的统一门面；
  Skill / MCP 两类转调本包 `repositories/agent-config-skill.ts` / `agent-config-mcp.ts`，知识库与记忆仍经
  对方公开入口）、`src/server/repositories/*`（资源行、编排域 `AgentConfigRepo` 的 PG 实现、站点应用，
  以及上述两张关联表的读写）、`src/server/services/agent-config-lookup.ts`（查询投影：按 ID 与按可见性读
  之外，还有 `findAgentConfigExecutionFields` / `findAgentConfigNamesByIds` 两个方法，供宿主绑定到
  agent-runtime 的 `AgentConfigLookupPort`）。
- **跨包取数面**：`src/server/repositories/agent-config.ts` 集中放「不经授权谓词、不是请求路径」的系统
  取数，每个函数只取消费者真正需要的列——只读的 `findAgentConfigNamesByIds`、
  `listAgentConfigsByOrganization`（含 `AgentConfigOwnershipRow`，服务 observer 人员树）、
  `searchAgentConfigsSystem`（服务 model-management 的系统管理面全局检索）、`isAgentConfigBoundToMachine`
  （服务 machine 删除前的悬空引用守卫），以及该文件**唯一**的写入口 `bindMachineIdByAgentName`（machine
  注册时按 `agentName` 绑定机器）。调用方因此拿不到整行去自行解释 `machineId` / `agentNode`。
- **模块配置**：`src/server/config.ts` 经 `getModuleConfig("agent-config")` 读取，并用 zod `strictObject`
  校验四个字段（`hiddenSidebarTabs`、`agentSitesBaseUrl`、`agentSitesMasterKey`、`agentGenerationModel`）。
  包内不读运行环境变量，值由宿主装配阶段注入。
- **表定义：本包对宿主表定义已零引用（§1.7 B9，2026-09-22）**：五张自有表在 `db/schema.ts`（出口
  `@fenix/agent-config/db`）；此前的最后一处宿主导入——`agent-related-resources.ts` 取
  `knowledge_base` 做知识库绑定投影——随该表迁入 `@fenix/resource-knowledge/db` 改为经
  `@fenix/resource-knowledge/server/summaries` 的只读投影入口（本包 `dependsOn` 已含 knowledge，
  边方向合法）。复核：`grep -rnE 'from "@server' packages/resources/agent-config/src | grep -v __tests__`
  → 1 行，是 `src/server/db.ts:19` 的文档注释（举例说明不该有的形状），**真实导入 0 处**；按裸字符串
  `grep -rl '@server/' packages/resources/agent-config/src --include='*.ts' | grep -v __tests__` → 8 个生产
  文件，全是注释/文档提及。历史降级链：B7 前有 8 个生产文件真实 import 该路径（`agent_config` 及关联表、
  `agent_site_app` 都在宿主 schema 里）→ B7 五表迁出降为 2 处 → B8 把 `agent-config-resource.ts` 取
  `environment` 改经 `@fenix/agent-runtime/server/environment` → B9 归零。五张表的跨包外键目标共五个——
  `user`（身份表）、`model`、`machine`、`mcpServer`、`skill`——都只在组装期导入、只取列对象表达级联语义，
  `package.json` 因此需声明对应依赖（B7 为此新增的只有 `@fenix/identity`，其余四条此前已在）。
- **测试基建**：`./server/testing` 提供 `createAgentConfigModuleConfig` /
  `initializeAgentConfigModuleConfig`（复位替身 + 以模块配置初始化应用基础设施，DB 句柄经转发代理）、
  Facade / Service / Associations / Identity 替身与模块替身装载器；未打桩的方法调用即失败。
- **exports**（`package.json`，实测）：`.`、`./db`（五张表的 schema，B7 新增；`drizzle.config.ts` 按此声明）、
  `./module`、`./server`、`./web`、`./web/i18n`、
  `./server/testing`、`./web/contribution` 与 3 条 `./web/lib/*` 窄口（`agent-node` /
  `agent-resource-access` / `agent-utils`，宿主壳与宿主测试按需取用，避免从包根入口把整棵编辑器
  页面图拉进壳层 chunk；`agent-create-navigation` 同此例，见 §1.6 T11e-3c），以及 6 条过渡子路径
  `./server/runtime`、`./server/system-prompt`、`./server/api-agent-schema`、`./server/config`、
  `./server/agent-launch-spec`、`./server/agent-config-lookup`（消费方见「边界残留」；后两条由宿主
  `services/pre-launch-ports.ts` 消费，`agent-config-lookup` 正是 `AgentConfigLookupPort` 的宿主实现入口）。

## web 面与 i18n

- **跨包 web 入口**：包根 `web/index.ts` 是聚合 barrel，从它出发的值导入图不含 `node:` 内建、`@server/*`
  与宿主别名 `@/`，由 `web/__tests__/agent-config-browser-surface.test.ts` 递归守护（含跨包递归与白名单
  说明）。`./web/i18n` 等窄子路径在 `exports` 显式声明，供消费方避开整棵页面图；`web/src/**`
  不是出口，也不应成为出口。
- 导出面覆盖实测消费方（2026-09-21）：task / prod-view 取 `agentApi`；model-management 的编辑器纯逻辑
  用例取 `agent-editor-model` 的转换与校验 schema；宿主 WebShell 的 `shell/use-shell-navigation.ts` 取
  `sidebarConfigApi`、`shell/use-agent-sidebar-tree.ts` 取 `agentApi`。
- **`AgentSidebarConfig` 已退场**（§1.6 T11d）：包根曾导出一个零消费方的 `AgentSidebarConfig`，与宿主
  `apps/web/src/pages/agent-panel/AgentSidebarConfig.tsx` 同源（均为 151 行，仅两处 import 不同）。
  侧栏导航的真相源现为各包 `web/contribution.ts` 的项声明 + WebShell 的分组表（`SHELL_NAV_GROUPS`），
  两侧副本与宿主旧表 `SIDEBAR_NAV_GROUPS` 同批删除；`filterNavGroups` 的纯逻辑与断言改由宿主
  `apps/web/src/shell/shell-navigation.ts` 持有——隐藏列表来自本包 `sidebarConfigApi`，被裁剪的却是
  Shell 装配出的导航，owner 因此是 Shell。本包只剩数据面（`./src/api/sidebar-config`）。
- **页面与组件域**：`web/pages/agent-panel/**`（编辑器、`AgentSitesPage`、`agent-sites-catalog`，
  以及随 §1.6 T11e 从宿主归位的三个 agent-panel 页面 `AgentManagementPage` / `AgentDashboardPage` /
  `AgentHomePage`）、
  `web/components/agent-panel/**`（`SiteFrame` / `SiteTabsBar` / `MountSiteDialog` / `AgentSitesCard`）、
  `web/api/**`、`web/hooks/**`、`web/lib/**`。
- **i18n 自持**：三份命名空间。`web/i18n/locales/{en,zh}/agents.json` 各 271 个键（编辑器与站点页）；
  `web/i18n/locales/{en,zh}/dashboard.json` 各 3 个键（`/agent/dashboard` 概览页）；
  `web/i18n/locales/{en,zh}/agentHome.json` 各 19 个键（`/agent/home`「创建智能体」首页与它的生成表单
  `AgentGenerationForm`）——三份字典的消费方随各自页面在 §1.6 T11e 归位，故按「键的最终所在地 = 包的
  owner」同批迁入。三份字典各自 en/zh 键结构一致（实测比对，由 `web/__tests__/agent-i18n.test.ts` 与
  `agent-config-browser-surface.test.ts` 守护）；命名空间常量由 `web/i18n/namespace.ts` 给出
  （`AGENTS_NS` / `DASHBOARD_NS` / `AGENT_HOME_NS`）。宿主在 i18n 初始化时经子路径
  `@fenix/agent-config/web/i18n` 取三组资源注册——走子路径而不是 `./web` 根入口，避免把整棵编辑器
  页面图拉进首屏 bundle；未注册时 i18next 回退为 key 回显。
  仍借宿主共享命名空间的只有两条：`components`（站点页签 / 挂载弹窗 / iframe 外壳）与 `agentPanel`
  （`siteDeployment.*`），它们的键同时被 apps/web 与别的包消费，整体搬迁需跨包裁定。
  迁移时顺带修掉一处**既有缺陷**：概览页正文取 `t("welcome")` 而宿主字典只有 `loading`（无消费方），
  迁入时按页面的实际键改为 `welcome` 并删掉 `loading`；此前该行显示的是字面量 `welcome`。

## 边界残留

- **表定义已全部迁出，宿主表定义引用归零（§1.7 B7 / B8 / B9，2026-09-22）**：`agent_config`、三张关联表
  （`agent_config_skill` / `agent_config_mcp` / `agent_config_site_app`）与 `agent_site_app` 的定义已迁到
  `db/schema.ts`（出口 `@fenix/agent-config/db`，DDL 逐字保留、`bun run check:schema-ddl-drift` 零差异）。
  此前唯一的宿主自有表残留 `knowledge_base` 已随 B9 迁入 `@fenix/resource-knowledge/db`，本包改经该包
  `./server/summaries` 的只读投影入口取 `{ name, slug }`，因此**本包已不再导入任何宿主 `@server/*`**。
  复核命令见「服务端交付物」的表定义条。
- **编排环境的读写改经 agent-runtime 公开入口（§1.7 B8，2026-09-22）**：`environment` / `agent_instance`
  两张表的定义已迁入 `@fenix/agent-runtime/db`，本包不再直读表对象。删除路径
  （`repositories/agent-config-resource.ts` 的 `removeWithEnvironments`）经
  `@fenix/agent-runtime/server/environment` 的 `deleteEnvironmentsByAgentConfig(tx, {...})`，把自己的事务
  句柄传进去——「删环境 + 删配置」仍是同一个事务，与迁移前在同一事务里 `tx.delete(environment)` 语义相同；
  重启前的枚举（`listBoundEnvironmentIds`）改经同出口的 `listEnvironmentIdsByAgentConfig`，只取 id。
  两个入口都不做授权（Facade 已判 `delete` / `use`），归属条件同时收 `organization_id` 与
  `agent_config_id`。包间方向 `agent-config → agent-runtime` 是 §2.3 登记的合法方向，此前已由
  `./runtime` 与 `./server/environment` 消费。
- **过渡 exports 子路径**（消费方实测，收敛到包根归宿主侧改动）：`./server/system-prompt` 被
  `apps/server/src/config.ts:2`、`apps/server/src/env.ts:2` 与宿主两条协议用例消费；`./server/config` 被宿主
  `config-validators` 用例消费；`./server/agent-launch-spec` 与 `./server/agent-config-lookup` 由宿主
  `apps/server/src/services/pre-launch-ports.ts`（第 16 / 20 行）消费；`./server/runtime` 与
  `./server/api-agent-schema` 分别由宿主装配与协议 schema 消费方使用。订正一处旧记录：本 README 此前把
  `packages/agent-runtime` 的 `launch-spec-builder.ts` 也记为 `./server/system-prompt` 的消费方——该文件已随
  任务 1.4 W4b 删除，实测 `grep -rn 'from "@fenix/agent-config' packages/agent-runtime/src --include='*.ts'
  | grep -v __tests__ | wc -l` → 0（该路径下对 `@fenix/agent-config` 的提及只剩注释）。
- **宿主侧第二份实现——已全部退场**：`apps/web/src/lib/agent-node.ts`、`agent-utils.ts`、
  `agent-resource-access.ts`（与包内 `web/lib/*` 同源）随 §1.6 T8d 的「宿主 `src/{api,hooks,lib,types}`
  副本簇退场」删除；`apps/web/src/pages/agent-panel/AgentSidebarConfig.tsx` 随 T11d 与其包内死副本同时
  删除；三个 agent-panel 页面（`AgentManagementPage` / `AgentHomePage` / `AgentDashboardPage`）与其
  自有字典、创建导航助手 `agent-create-navigation.ts` 随 T11e 迁入本包。本包 web 面对宿主源码已零引用。
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
- **宿主侧启动同步的覆盖缺口**：内置 Skill 启动编排由宿主 `apps/server/src/services/sync-builtin.ts` 负责。
  本包 `builtin-skills` 用例只覆盖系统托管 Skill 的挑选与公开化，宿主编排的等价覆盖仍需补齐。
- **模块配置字段暂由宿主直接提供**（`moduleConfigs["agent-config"]`），未走模块 `envDefinitions`；
  声明、校验与 preflight 收敛归任务 1.7。
- **§1.3(3) 的后半段「生成已授权 LaunchSpec 再调 Runtime port」仍未实现（B7 已缩小差距）**：Facade 只覆盖
  CRUD 与 `restartInstances`（后者校验 `use` 动作，成员默认具备），不产出 LaunchSpec。B7 把 agent-runtime
  对 `agent_config` 的读点从「直读宿主 schema」改为经宿主注入的 `AgentConfigLookupPort`
  （`findAgentConfigExecutionFields` / `findAgentConfigNamesByIds`，见该包
  `services/agent-config-lookup-port.ts`；`agentConfigRepo` 与 `launch-spec-builder.ts` 已不在该包），
  但读取仍是**不经 ActorContext、不校验 `use` 动作**的启动期取数。影响面：启动期授权未经过本包 Facade，
  agent 配置读取尚未收敛为「已授权的启动输入」。该项属 **§1.4** 范围；原先指向的架构台账条目
  `agent-runtime-not-to-resources`（`@fenix/agent-runtime → @fenix/agent-config`）已不在
  `scripts/architecture/exceptions.json` 中（实测 `grep -c "agent-runtime-not-to-resources"
  scripts/architecture/exceptions.json` → 0），余下的「Facade 补 `use` 授权与 LaunchSpec 生成」仍待落地。
- **（2026-09-20 复核已解除）本包 web 面在 `bun test` 中的求值失败，原因为宿主 i18n 旧深链**：宿主
  `apps/web/src/i18n/index.ts` 原先按各包旧布局深链 `web/i18n/{en,zh}/*.json`，经 `@fenix/identity/web`
  的 `OrgContext.tsx`（走宿主别名 `@/src/i18n`）把失效路径拉进本包值导入图，令 `@fenix/agent-config/web`
  在无 DOM 的 `bun test` 进程里 import 期即 `Cannot find module`。宿主改经 `@fenix/<pkg>/web/i18n` 子路径
  登记后该链已恢复：实测消费方用例
  `packages/resources/model-management/web/src/__tests__/agent-editor-model.test.ts` 13 pass / 0 fail
  （该文件头部记录了同一结论）。仅存的深链是 `@fenix/identity` 的 `apikey` / `orgs` 字典（纯 JSON 相对
  导入，可正常求值），属该包的 i18n 出口债，不构成本包阻塞。
- **包内不装配 access-control / identity**：`createAgentConfigModule()` 返回已装入的装配结果入口，
  由宿主注入授权与身份目录；registry 装配落地时应改为从 `context.modules` 取实例（§1.5）。
