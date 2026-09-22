# @fenix/resource-sandbox

沙盒资源池、沙盒实例生命周期与远程 Sandbox Cluster 管理协议的唯一 owner：服务端实现、路由工厂、浏览器出口与文案都在本包内，宿主 `apps/server` 不再持有沙盒领域实现——生产装配经本包 `fenix.module.ts` 的四条 `app-route` 贡献（`web-config` 槽 1 条 + `api` 槽 3 条）动态 `import()` 到 `src/server/assembly.ts` 的 `createSandbox*Routes(host)`，宿主只提供 `ServerRouteHost` 端口实现（`apps/server/src/bootstrap/route-host.ts`）；宿主里直接点名本包路由工厂的**只有测试工具** `apps/server/src/test-utils/route-faces.ts`（不经 assembly 收窄，直接 `createWebSandboxPoolsRoutes({ authGuardPlugin })` 等四个工厂，用于拼出与生产同形的测试协议面）。宿主侧与沙盒相关的残留只剩 env 声明与装配期配置构造（`env.ts`、`config.ts`，归 §1.5/§1.7），表定义已于任务 1.7 B4（2026-09-22）迁入本包 `db/schema.ts`。22 条宿主→包迁移对由 `src/__tests__/sandbox-source-migration.test.ts` 逐条断言「宿主旧路径已删、包内新路径存在」。（2026-09-22 订正：本行此前写「`apps/server/src/routes/web/config/index.ts` 调 `createWebSandboxPoolsRoutes`，`apps/server/src/main.ts` 调 `createApiSandbox*Routes`」——实测这两个文件没有任何 sandbox 引用，且 `createApiSandbox*Routes` 是本包 assembly 的导出名，宿主从不调用它。）

本包是任务 1.3 的 W0 黄金样本：其余 12 个资源包的交付物形状（manifest、`./web`、`./server/testing`、路由工厂 + 守卫注入、包内契约测试、README 五段式）以本包为模板复制。

## 定位与 owner

- **资源池与实例**：`sandbox_pool` / `sandbox_instance` 的领域规则与状态机。`SandboxManager`（`src/server/services/sandbox-manager.ts`）负责复用、配置快照、重建、删除与重启恢复；`SandboxRemoteReconciler`（`sandbox-remote-reconciler.ts`）负责外部副作用与并发协调（Provider 查询/创建/恢复/销毁、行锁、machine 路由与心跳释放）。两者由 `SandboxManager` 组合，测试可单独驱动协调器。
- **机器事件的实例投影**：机器注册与机器心跳对 `sandbox_instance` 的影响（把 `creating` / `starting` / `recovering` 的实例提升为 `ready`、刷新 `last_heartbeat_at`）由本包写（`src/server/repositories/sandbox-instance-repository.ts` 的 `markSandboxInstancesReadyForMachine` / `touchSandboxInstancesHeartbeatByMachine`）。**为什么是本包**（§1.7 B4 前置，2026-09-22）：写入的是本包的表，「哪些状态算中间态、心跳写哪一列」是本包的领域知识；此前这段 UPDATE 写在 `@fenix/resource-machine` 内，表归本包后便构成 §2.3 禁止的 `machine → sandbox` 写路径（§6.1 的组装期例外只覆盖 `db/**`）。方向仍是 sandbox → machine：本包在 `createSandboxModule()` 里把实现绑到 machine 的 `MachineLifecyclePort`（与该包已有的 `MachineSandboxRoutePort` 同形，未绑定=正常降级），machine 只负责通报事件。
- **Provider 抽象**：`SandboxProviderRegistry` 与 `@fenix/sandbox-provider` 的具体实现。装配期由 `registerConfiguredSandboxProviders()` 按模块配置注册，模块加载期不发网络请求。
- **执行入口**：`SandboxExecutionHandler` 把一次执行请求解析为可用的沙盒实例，等待 Machine 回连后返回 `machine_id` 作为寻址节点；`@fenix/agent-runtime` 的 `orchestration-bootstrap.ts` 是它的消费方。
- **远程 Cluster 管理**：`createSandboxClusterClient()` 在服务端附加 Cluster 凭据，浏览器不接触该凭据（浏览器侧的 `systemSandboxApi` 只带 Master Key）。
- **模块组合根**：`src/module.ts` 的 `createSandboxModule()` 返回进程级单例（`providers` / `manager` / `executions`）。只暴露需要对象身份的能力：`sandboxManager` 持有进程内的 provider 句柄、心跳定时器与实例锁，再构造一个实例等于给同一批 DB 记录开两条回收路径。`fenix.module.ts` 是它的惰性描述符（`create` 用动态 `import()`，避免 registry 索引层把 Drizzle、Elysia 与 provider SDK 拖进模块图）。

## 服务端交付物

- **HTTP 交付物**：`/api/system/sandbox-pools`（含 `/:poolId`）、`/api/system/sandbox-instances`（含 `/:instanceId` 与 `/rebuild`）、`/api/system/sandbox-cluster`、`/api/system/sandbox-server` 与 `/web/config/sandbox-pools`。路由目录是 `src/server/routes/**`（计划 §2.3 的包内树）：4 个路由文件 + 1 个依赖类型文件，全部以工厂形式导出：

```ts
import {
  createApiSandboxRoutes,
  createApiSandboxClusterRoutes,
  createApiSandboxServerRoutes,
  createWebSandboxPoolsRoutes,
} from "@fenix/resource-sandbox/server";

const apiSandbox = createApiSandboxRoutes({ systemApiGuardPlugin: systemApiAuthPlugin });
const webSandboxPools = createWebSandboxPoolsRoutes({ authGuardPlugin });
```

- **共享错误映射在 `src/server/error-mapping.ts`**：`mapSandboxClusterAdminError` 同时被 `sandbox-cluster` 与 `sandbox-server` 两个 route 消费，因此不落在 `routes/` 内——放任一方都会形成计划 §1.3(2) 禁止的 route → route 依赖边。它仍经包根 `./server` 再导出，公开导入路径不变；`src/__tests__/sandbox-source-migration.test.ts` 有一条断言持续检查路由模块之间不存在相互依赖边。
- **守卫由宿主注入，本包不导出守卫实例**。`authGuardPlugin` / `systemApiGuardPlugin` 的依赖类型写在 `src/server/routes/dependencies.ts`（只放类型：类型若写在包入口会出现「入口 → 工厂 → 入口」的导入环）。必须注入而不能自建：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填；守卫必须与宿主的认证解析（含测试 seam、ALS 增强、active organization 解析）是同一份实例——两份同名实例会被 Elysia 按 plugin `name` 去重，先构造的一方静默生效。
- **出口形状**：`./server` 是具名再导出、没有 default（实测 `grep -cE "^export" src/server.ts` → 23 条）；`./server/testing` 自持模块配置夹具（`createSandboxModuleConfig` / `initializeSandboxModuleConfig`），消费方是 machine 包的 `server/testing` 子路径与宿主 `test-utils/setup-mocks.ts`——同一份「必填字段 + 缺省值」只写一次，避免宿主与包内各抄一份字段清单。
- **仓库是唯一数据访问点**：`getSandboxDatabase()` 的使用点只有 `src/server/db.ts`（定义）与 `src/server/repositories/{sandbox-pool-repository,sandbox-instance-repository}.ts`（实测 `grep -rn "getSandboxDatabase" src` → 25 处提及、`grep -rn "getSandboxDatabase()" src` → 23 处，命中只落在这三个文件内）；`src/server/routes/**` 与 `src/server/services/**` 不直接取 DB 句柄或表对象。
- **配置**：`getSandboxConfig()` 经 `getModuleConfig("sandbox")` 取宿主已校验的值，并用 `z.strictObject` 校验形状（`z.ZodType<SandboxModuleConfig>` 标注让「接口加了字段而 schema 没加」在编译期报错；未知字段运行期拒绝）。包内不读 `process.env`、不读 `.env`（实测 `grep -rn "process\.env" src` → 0 条）。
- **DB 句柄类型**：`NodePgDatabase<Record<string, never>>`——刻意不写 `typeof schema`，仓储只做 `select` / `insert` / `update` / `delete` / `transaction`，不使用 `db.query.*`，因此表定义迁出后这里无需改形状（B4 已迁出，确认未改）。句柄在每个方法内取，不在模块加载期持有（加载早于宿主 `initializeApplicationInfrastructure()`）。

## web 面与 i18n

- **浏览器出口**：`web/index.ts` 是 `exports["./web"]` 的目标，包与宿主消费本包浏览器能力的根入口（`./web/i18n` 是只导出语言资源的独立子路径，供宿主 i18n 启动期注册：从根入口导入会把整张沙盒页面图拉进首屏 bundle）。实测 23 个值导出 + 类型导出，覆盖包外 10 个消费文件（口径 `grep -rln '"@fenix/resource-sandbox/web"' --include='*.ts' --include='*.tsx' packages apps` 去掉本包与 `__tests__` 后为 10 个，含 `observer/web/__tests__/admin-observer-utils.test.ts` 则 11 个；资源包侧 9 个见下，另有宿主 `apps/web/src/routes/admin/sandbox.tsx`）：
  - `observer`（7 个文件，另有 1 个测试文件）取 `MasterKeyGate`、`FlatRow` / `IntegrityRow` / `YjsSessionGroup` 类型与 `mergeFlatRows` / `machineReverseIndex` / `integrityRows` / `name` / `groupYjsSessions` / `sessionTabCounts` / `chatRelayPayload` / `formatClockTime` / `formatDuration`；
  - `model-management/web/pages/admin/AdminModelGatewayPage.tsx` 取 `MasterKeyGate`、`SearchableUsageFilter`；
  - `agent-config/web/pages/agent-panel/agent-editor/use-agent-editor.ts` 取 `sandboxPoolApi`。
  宿主侧消费 `apps/web/src/routes/admin/sandbox.tsx`（懒加载 `AdminSandboxPage`）与 `apps/web/src/i18n/index.ts`（经 `./web/i18n` 子路径，不经过 `./web` 根入口，故不计入上述 10 个）。
- **浏览器安全由值导入图守护**：`web/__tests__/sandbox-browser-surface.test.ts` 从 `web/index.ts` 出发递归走值导入图（`@fenix/<pkg>/<subpath>` 经对方 `exports` 解析到真实源文件后继续递归，遍历口径在 `web/__tests__/value-import-graph.ts`），白名单只留浏览器安全外部依赖（宿主提供的 peerDependency 与经 `@fenix/ui-components` 传递进入的无样式原语）。断言覆盖 `node:*`、`@server/*`、宿主别名 `@/src|@/components`、`@fenix/*/src` 深路径、exports 解析失败、未白名单外部库、自我回环，并有一条注入本包 `./server` 出口的负例。包内 web 零宿主别名（实测 `grep -rnE "from \"@/" web` → 0 条）。
- **i18n 自持**：`web/i18n/{namespace.ts,index.ts,locales/{en,zh}/sandbox.json}`。命名空间 `SANDBOX_NS = "sandbox"` 由本包声明（键的最终所在地 = 包的 owner），宿主从子路径 `@fenix/resource-sandbox/web/i18n` 注册 `sandboxResources.en/zh`——子路径而非 `./web` 根入口，因为宿主 i18n 模块在应用启动时就求值，从根入口导入会把整张沙盒页面图拉进首屏 bundle。
- **键的来源与残留**：这批键原寄居 observer 命名空间（W0 迁出）。对 HEAD 快照逐键对比（`git show HEAD:packages/resources/observer/web/i18n/zh/observer.json` 的 `sandbox` 组 vs 本包字典）：observer 组的 60 个键里有 54 个已在本包字典且**值逐字相同**，字典覆盖源码全部字面量 `t("key")`（两语言各 124 个顶层键，由 `web/__tests__/sandbox-i18n.test.ts` 守护 en/zh 键集与 `{{var}}` 插值一致）。observer 组剩余的 6 个键（`cpuCount`、`healthCheckSuccess`、`memoryTotal`、`memoryUsed`、`remoteDiagnosticsError`、`tunnelSuccess`）全仓已无消费方（`grep -rn` 在 `*.ts`/`*.tsx`/`*.json` 内零命中），随 observer 切片的命名空间清理一并删除即可。
- **JSON 路径未动**：`web/i18n/locales/{en,zh}/sandbox.json` 保持原路径（实测 `git diff HEAD --name-only -- packages/resources/sandbox/web/i18n/locales` → 空）——宿主 `apps/web/src/i18n/index.ts` 已不再以深层相对路径 import 这两个文件，改为经包出口 `@fenix/resource-sandbox/web/i18n` 取 `{ SANDBOX_NS, sandboxResources }` 并注册（实测该文件第 21 行 import、第 125 / 139 行分别为 `sandboxResources.en` / `.zh`）；本包出口与宿主指向同一批 JSON，不复制字典。该文件属任务 1.3 §4 的共享文件，进一步改动归编排者。

## 边界残留

- **宿主内部依赖已清零（任务 1.7 B4，2026-09-22）**：`sandbox_pool` / `sandbox_instance` 与其 4 个推断类型迁入本包 `db/schema.ts`（出口 `@fenix/resource-sandbox/db`，`drizzle.config.ts` 已声明，DDL 逐字保留、`bun run check:schema-ddl-drift` 零差异）。**导入口径**是唯一的判据（宿主导入会让本包失去独立构建能力）：`@server/**` 导入 **0 处**，此前 9 处表定义导入（生产 6 个文件 + 测试 3 个文件）全部改指本包出口。**文本口径**（`command grep -rnE '@server' src web db fenix.module.ts`）命中 **14 处，全部不是导入**（数量随夹具与断言文本变化，判据是导入口径）：`web/index.ts:4` 1 处（文件头注释列举「浏览器安全 = 值导入图里不出现 `node:` 内建 / `@server/*` / 宿主别名」，是**生产文件里的注释文字**）、`src/__tests__/sandbox-source-migration.test.ts` 7 处与 `web/__tests__/sandbox-browser-surface.test.ts` 6 处（扫描器夹具的字符串字面量与断言文本）。（2026-09-22 订正：本行此前写「生产代码实测 → 0 处」，那是把文本口径误记成导入口径——它掩盖了 `web/index.ts` 那一处，也让「生产文件里出现 `@server` 字样」与「出现宿主导入」两件事混淆。）因此：
  - `scripts/architecture/exceptions.json` 的 `apps-boundary @fenix/resource-sandbox → @fenix/server-app` 条目**已按 §4.8 第 2 条的删除条件删除**（「该包最后一个跨模块表读取消失」），`bun run architecture:check` 由门禁自身确认该条目已成 stale（删除前报「已不再违规，必须删除」，删除后 2127 files / 18 条例外全绿）——这是本包零 `@server` 依赖的机器证据，比逐条 grep 更强。
  - `src/server/db.ts` 的句柄类型无需改动（本就刻意不写 `typeof schema`）。
  - `sandbox-source-migration.test.ts` 的「表定义残留 > 0」正向控制随之失效（此刻扫不到才是正确结果），按 §4.7.1 ③ 收缩为**负例夹具自检**：一段真实源码形状的字符串含宿主导入与注释里形似导入的文本，断言「前者被捞出、后者被剥掉」。`SCANNER_FIXTURE` 按行以字符串字面量拼成，源码里 `import` 前始终有引号，不会被本文件的真实扫描误判。**夹具的注释行必须是块注释形状**（2026-09-22 审计整改）：`SPECIFIER_PATTERNS` 的 `from` 形式带 `^[ \t]*` 行首锚点，行注释 `// import …` 的行首是 `/` 不是 `import`，未剥注释时本就不在候选集里——用行注释做这条负例时 `stripComments` 失效也不报红。改为块注释后断言拆成两条（未剥注释时两条说明符都要被捞出、剥掉后只剩真实导入），并把 `db/schema.ts` 加进遍历有效性自检的 `toContain` 清单（否则 `db/**` 从扫描集掉出去也无断言报红）；判据与变异证据见 `sandbox-source-migration.test.ts` 的负例夹具自检。
  - 唯一跨包外键目标仍是身份表（`organization` / `user`，经 `@fenix/identity/db` 取表对象表达级联行为），`package.json` 为此新增 `@fenix/identity`；`sandbox_instance.machine_id` 历史 DDL 上就是无约束列，因此不导入 machine 包。
- **需要编排者落盘的共享文件 patch**（包切片按 §4 禁写 `scripts/**`、`apps/**`、`docs/**`）：
  1. ~~`scripts/architecture/exceptions.json` 的 `apps-boundary @fenix/resource-sandbox → @fenix/server-app` 条目~~：**已删除**（任务 1.7 B4，2026-09-22）——本包已零 `@server` 引用，条目按 §4.8 第 2 条的条件退场。
  2. `scripts/__tests__/rmd-07-migration.test.ts` 第 93–94 行的注释仍指向旧路径 `packages/resources/sandbox/src/routes/web/sandbox-pools.ts`（本任务已移入 `src/server/routes/web/`）；该处只是注释文本，不影响断言。
  3. `packages/web-runtime/web/i18n/namespace.ts` 的 `NS` 表未登记 `SANDBOX`；宿主当前直接取 `SANDBOX_NS`，登记后可与其余命名空间同形（跨包文件，不在本包切片内）。
  4. ~~文档侧旧路径引用（`docs/arch/root-source-owner-inventory.md:53`、`FUNCTIONAL_MODULE_INVENTORY.md:54,104`）随目录收敛更新~~：**已消解**。`FUNCTIONAL_MODULE_INVENTORY.md` 已随台账收敛提交（`64c1cd44e`，同批删除逐任务 review 台账与阶段计划）删除；`docs/arch/root-source-owner-inventory.md` 里保留的旧路径是**生成物中的历史快照**，其文件头已声明「表中路径不作为现状依据」，无需逐条更新。
- **`web/src/api/system-organizations.ts` 是组织目录客户端的窄投影副本**：它与 observer 的 `web/api/system-people-tree.ts` 请求同一端点 `GET /api/system/people-tree/`，本文件只保留组织下拉用到的 `id` / `name` / `slug` 三个字段，因此不合并（合并会把 observer 的视图模型带进本包依赖图）。**保留理由 = 包级环**：observer 的 `dependencies` 已含 `@fenix/resource-sandbox`（其面板经 `@fenix/resource-sandbox/web` 消费本包组件与工具函数），本包反向 import 会形成两个包互相依赖，违反依赖矩阵且装配顺序不确定。**影响面**：`people-tree` 的组织层字段形状变化需两处同步，且本文件按字段取值、未知字段静默忽略，上游改名不会在编译期报错。**移除条件**：组织目录的 owner（identity）提供无环的公开组织目录客户端后，删除本文件，并把 `use-sandbox-dashboard` / `PoolDialog` / `OrganizationSelect` 的类型与调用改指该客户端。
- **未声明 `manifest.contributions` 与 `manifest.web`**：消费方分别是 §1.5 的宿主挂载（`mountContribution`）与 §1.6 的 WebShell 装配，形状需与消费端同时定型；当前宿主按显式调用装配（路由工厂注入守卫），不形成第二套装配路径。

## 已知项

- **observer 域纯函数寄居本包（待 W4 收敛）**：`web/src/pages/admin/utils.ts`（`mergeFlatRows` / `machineReverseIndex` / `integrityRows` / `name` / `groupYjsSessions` / `sessionTabCounts` / `chatRelayPayload` / 时间格式化，由 `web/index.ts` 的 `export * from "./src/pages/admin/utils"` 整体转出）与 `web/src/types/acp-link-view.ts`（observer 视图模型的结构镜像，仅被前者 import）语义上属 observer，被 observer 的 5 个页面/组件（`AdminObserverPage` 与 `ObserverFlatTable` / `ObserverOrgTree` / `ObserverMachineTree` / `ObserverIntegrityAlert`；「web 面与 i18n」一节列出的 7 个 observer 文件里，另 2 个只取本包的 `MasterKeyGate`）外加 `web/__tests__/admin-observer-utils.test.ts` 经 `@fenix/resource-sandbox/web` 消费，**不是死代码**。**旧保留理由已证伪**（2026-09-20 实测）：observer 的 `package.json` 现为 `.` / `./module` / `./server` / `./web` / `./web/i18n` 五个 exports，`observer/web/index.ts` 已建立并 `export * from "./api/observer"`，原先写的「observer 只有三个 exports、`web/index.ts` 尚未建立」不成立（同一结论见本包 `web/src/api/system-organizations.ts` 文件头）。**仍未迁走的真实理由**：搬去 observer 是跨包改动——本包 `web/index.ts` 要撤掉 `export * from "./src/pages/admin/utils"`、observer 的 5 个消费文件要改指自己包，属收敛任务（W4）的切片；反之在本包 `import type` observer 的真实视图模型会形成包级环（observer 的 `dependencies` 已含 `@fenix/resource-sandbox`，依赖矩阵禁止互环）。**移除条件**：W4 把这两个文件并入 observer 的 `web/api/observer.ts` 后，本包 `web/index.ts` 与 `web/__tests__/sandbox-browser-surface.test.ts` 的导出面同批收敛。
- **`/api/system/sandbox*` 的真实守卫合同无测试覆盖**：守卫改为工厂注入后包内只能注入替身，替身放行不等于合同已验。宿主 `apps/server/src/__tests__/api-system-routes.test.ts` 装配的是 identity 的 `createApiSystemRoutes`，无任何 `/api/system/sandbox*` 用例，因此「无 key / 错误 key / 未配置 `RCS_SYSTEM_API_KEYS` 三种情形被拒绝」当前无覆盖，归 §1.5 的宿主协议聚合（详见 `src/__tests__/guard-stubs.ts` 的文件头）。
- **`dependsOn: ["machine"]` 与 machine 侧的反向边**：本包生产代码静态导入 `@fenix/resource-machine/server` 的公开入口（`createSandboxMachine`、`isMachineOnline`、`releaseMachineRuntime`、`stopHeartbeat`、`findMachinesBasicInfoByIds`），两者必须成套启用，方向与 §2.3 固定的 `sandbox → machine` 一致。machine 侧的反向边（`machine → sandbox`）已由架构台账登记为 `special-dependency`（owner 1.4，removeWhen：machine 不再依赖 sandbox），属必须消除的越界边，因此 machine 不声明本模块：把它写进 `dependsOn` 会被生成器以「已由架构台账登记为越界边」拒绝，两个模块同时启用时装配顺序也会因循环失败。
- **`restart` 不持有行锁**：它只复用已存在的 Provider 资源、不创建新资源，与 `recover`（锁内重建）的并发边界不同；若将来 `restart` 需要创建资源，必须一并纳入锁内。
- **`envDefinitions` 与 preflight 收敛在任务 1.7**：本包的配置字段暂由宿主 `apps/server/src/env.ts` 构造后经 `initializeApplicationInfrastructure({ moduleConfigs })` 注入，包内不做第二份环境解析（两处默认值一旦分歧便无法在启动期暴露，也会把部署知识泄漏进资源模块）。
