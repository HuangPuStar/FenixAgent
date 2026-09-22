# @fenix/resource-machine

远程机器（RCS machine）的注册与心跳、Agent 进程路由、file-ws 传输与 workspace 文件域的唯一 owner。

## 定位与 owner

本包属 `resources` 类别，解析 AgentNode 为执行节点、承载机器侧文件读写。装配面上的消费者：宿主
`apps/server`（挂载路由、接入 file-ws、启动心跳巡检、优雅关闭）、`@fenix/resource-sandbox`（机器寻址、
沙盒路由判定、向本包注入机器生命周期端口）与 `@fenix/resource-observer`（读机器注册表），三者入口都是本包
`./server` 的公开面。

**调用期的跨包取数一律经宿主注入的端口**（2026-09-21 §1.7 B1 起）：`@fenix/agent-runtime` 经
`MachineRegistryPort.findMachineAgentNamesByIds`、`@fenix/resource-agent-config` 经它自己的
`MachineLookupPort.findMachineLabelsByIds` 取机器展示投影，两者都由宿主绑定到本包
`repositories/machine-repository.ts` 的实现。消费方**不得**导入本包的表对象（§2.2 / §2.3：组装期例外只在
各包 `db/` 内成立），也**不得**直接导入本包的公开入口——本包 `dependsOn` 已含 `agent-config`
（`remote-file-service.ts` 解析 AgentNode，B7 起还有 `registry.ts` 经它读写 `agent_config.machineId`），
agent-config 再反向声明 `dependsOn: ["machine"]` 会在模块
装配期闭合二元环，所有 profile 都会因装配顺序失败。`@fenix/agent-runtime` 的机器注册 / 心跳 / 断连能力
同走 `MachineRegistryPort`，`@fenix/agent-config` 的浏览器侧只经 `./web` 取 `registryApi`。机器元数据不在
这里重复建表。

强断言的实测口径（改动本节时同步复跑，避免留下不成立的「唯一 / 只有 / 全部」）：

- **写入口收敛**：`grep -rln "insert(machine)\|update(machine)\|delete(machine)" packages apps --include="*.ts"`
  实测 1 个文件——本包 `src/server/services/registry.ts`。宿主启动时按 `RCS_DEFAULT_MACHINE_ID` 补建 pending
  机器已不再自己写表，改为调用本包导出的 `ensureDefaultMachine`（`apps/server/src/services/core-bootstrap.ts:85`）。
  因此准确说法是「`machine` 的写入点只有本包；`registry_event` 同样只有本包（`repositories/registry-event.ts`
  与 `services/registry.ts`）」。
- **file-ws 帧处理实现**：`grep -rln "export function handleFileWs\|export function parseFileWsMessage\|export function formatFileWsCloseLog"`
  实测 4 个文件——`src/server/transport/` 的 `file-ws-handler.ts` / `file-ws-payload.ts` / `file-ws-close-log.ts`
  加 `src/server/services/file-machine-events.ts`（事件接收侧）；`@fenix/agent-runtime` 只持有 `FileWsPort` 接口
  （`packages/agent-runtime/src/server/services/file-ws-port.ts`），由宿主把本包实现绑进去，
  runtime 不反向导入本包。`acp-link` 是机器侧客户端，与端点实现对侧。
- **路由交付面只有工厂**：`grep -rn "export function create" src/server/routes/` 实测 4 个工厂
  （`createWebFsRoutes` / `createWebFileEventsRoutes` / `createWebRegistryRoutes` / `createApiWorkspaceRoutes`），
  本包不再导出已构造的路由实例——守卫由宿主注入，见「守卫由宿主注入」一节。
- **宿主内部依赖已归零**：§1.7 B1 把本包自己的 `machine` / `registry_event` 迁到 `./db`
  （`@fenix/resource-machine/db`），B7 又把最后一处跨模块表读取——`registry.ts` 直读 `agent_config`——
  改经 owner 的公开入口。两条口径的实测：`grep -rn 'from "@server' src/` → **0 条**；`grep -rn '@server' src/`
  → 4 个文件（`src/` 口径）、全是注释与断言文本（`transport/ws-types.ts` 解释为何 `ws-types` 由本包声明、
  `__tests__/host-port-stub.ts` 记为什么本包不得 import `@server/services/core-bootstrap`；测试侧为
  契约测试的说明与 `specifier.startsWith("@server")` 断言、`registry-schema.test.ts` 的两处注记
  ——`@server/db/schema` 列断言的删除说明与 `@server/env` 断言的迁出说明）。契约测试的 `@server` 白名单因此整条删除、改为**零例外**
  （`machine-package-contract.test.ts`：任何 `@server` 说明符，含深路径与动态 `import()`，都是违规）；
  `registry-schema.test.ts` 里「`agent_config` 包含 `machineId` 列」的断言也一并删除——资源包不该断言别包
  的表结构，列名映射由 `bun run check:schema-ddl-drift` 覆盖。

## 服务端交付物

- **路由**（`src/server/routes/**`）：`web/registry.ts`（`/web/registry/machines[/:id][/events]`）、
  `web/fs.ts`（`/web/environments/:id/fs/*`：tree / list / read / write / upload / delete / mkdir / rename /
  batch / download-zip）、`web/file-events.ts`（WS `/web/file-events`）与 `api/workspaces.ts`
  （`/api/environments/:environmentId/workspace/files`）。依赖类型在 `routes/dependencies.ts`（只放类型，
  避免「入口 → 工厂 → 入口」的循环导入）。
- **注册表领域**（`src/server/services/registry.ts`）：管理面 `listMachines` / `getMachine` / `createMachine` /
  `updateMachine` / `deleteMachine` / `listEvents`；连接侧 `registerMachine` 只激活运行时状态（未预创建的机器
  直接拒绝，不支持自动注册），`disconnectMachine` / `markHeartbeatTimeout` / `updateHeartbeat` 都不写元数据
  字段。沙盒侧预创建走 `createSandboxMachine` / `deleteSandboxMachine`（只作补偿清理），进程启动时
  `resetAllMachinesOffline()` 复位残留 online。
- **心跳与巡检**（`registry-heartbeat.ts`）：`startHeartbeat` / `handleHeartbeat` 按 3 倍心跳间隔判超时，
  `startMachineSweep`（默认 60s）把「DB 记 online 但对不上活跃 WS」的机器收敛为 offline 并触发 relay 清理；
  两者是进程级定时器，随连接生命周期 `stop*`。
- **连接等待**（`machine-connection-waiter.ts`）：`waitForMachineConnection` 以共享 DB 轮询（1s 起、线性退避）
  等待回连，超时或 `AbortSignal` 抛出 `MachineConnectionTimeoutError`；sandbox 的执行入口据此寻址机器。
- **文件域**：`services/agent-file-service.ts` 是门面（本地 / 远程路由与统一错误映射），
  `services/file-backends.ts` 是执行后端（`LocalBackend` 包 `workspace-fs`、`RemoteBackend` 包
  `remote-file-service`），`services/workspace-fs.ts` 负责路径解析与 realpath 越界防护；远端经 file-ws 传输
  （`transport/file-ws-*` 与 `transport/file-op-retry.ts` 的重试熔断）。远端需宿主绑定 `FileWsPort` 的实现。
- **生命周期通报与运行时释放**：`machine-lifecycle-port.ts` 把「机器 X 在 T 注册 / 心跳」通报给消费方，
  投影由接收方在自己的表上完成（§1.7 B4 前置：`sandbox_instance` 是 sandbox 的表，写它的语义也就归它；
  本包此前直接 UPDATE 该表，属 §2.3 禁止的 `machine → sandbox` 写路径）；`services/machine-runtime.ts` 的
  `releaseMachineRuntime` 经 `MachineHostPort.unregisterCoreRuntimeNode` 注销远端节点（实现由宿主绑定，
  见「宿主运行态端口」）。
- **本地节点**：`src/services/local-node-service.ts` 的 `LocalNodeAwareService` 为 `local-default` 提供常驻
  在线的 stub AgentNode，其余 machineId 原样委托真实节点服务。
- **数据访问**：`src/server/db.ts` 是包内唯一 DB 句柄（`getDatabase()`），3 个 repository
  （`repositories/{machine-repository,agent-machine,registry-event}.ts`）是表级读写封装。
- **模块组合根**：`src/module.ts` 的 `createMachineModule()` 返回进程级单例入口（file-ws 连接索引、心跳 /
  巡检定时器、文件事件队列三处可变状态各要求进程内唯一），`fenix.module.ts` 是它的惰性描述符。
  不声明 `contributions` 与 `web`：消费方是 §1.5 的宿主挂载与 §1.6 的 WebShell 装配，形状需与消费端同时定型。
- **测试装配**：`/server/testing` 提供 `createMachineModuleConfig` / `initializeMachineModuleConfig` /
  `stubMachineConfig` / `stubMachineEnvironment(Record)` / `stubFileWsTransport` 与三个句柄替换入口；
  包内用例另用 `src/__tests__/guard-stubs.ts` 注入守卫替身。

## web 面与 i18n

- **浏览器出口**：`web/index.ts`（`package.json` 的 `exports["./web"]` 指向它），当前导出面是
  `web/api/registry.ts` 的 `registryApi` 与记录 / 查询 / 响应类型。跨包消费方（agent-config 的 Agent 编辑器、
  identity 的组织机器页）取用的就是这一份，必须走包根 `@fenix/resource-machine/web`——`web/api/registry` 这类
  深层路径会把本包的内部目录变成事实契约。
- **浏览器面守卫**：`web/__tests__/machine-browser-surface.test.ts` 静态走值导入图（`web/__tests__/value-import-graph.ts`），
  跨包说明符经对方 `exports` 递归进入；白名单当前为空（实测入口图只有 3 个文件、无裸包说明符），
  另含负例注入（`@fenix/resource-machine/server` 必须被拦下）与「相对路径不得越界到 `apps/web`」一条。
- **i18n 零迁出零迁入**（键的最终所在地 = 包的 owner）：本包没有自持命名空间，也没有需要迁出的寄居键，
  因此**不建** `web/i18n/**`——空壳命名空间会让宿主登记一份没有字典的 ns，读键时整片回退成 key 回显。
  实测口径：宿主 `apps/web/src/i18n/index.ts` 的 `NS` 表无 machine 项（`grep -in machine` 命中 0）；
  `git ls-files` 里唯一的 machine JSON 是本包 `package.json` 本身，没有任何 i18n 字典；observer 命名空间按
  「递归展开全部键（含数组内对象键）」对齐 `HEAD` 快照——zh / en 各 364 键，丢失 0、新增 0，其中 4 个含 machine 字样的键
  （`overview.machines` / `tree.machineTree` / `tree.selectMachine` / `flat.machineId`）是 observer 页面自身的
  标签，不属本包。本包尚未迁入的页面（注册表页、文件域）读的是宿主 `components` / `agentPanel` 命名空间，
  键随实现一起在 §1.6 迁出。
- **测试归属（W2.5 收敛后）**：`web/src/__tests__/` 的 6 个文件全部改为对**共享实现公开入口**的消费方断言，
  不再有一处穿透到 `apps/web`：`grep -rnE '\.\./\.\./\.\./.*apps/web' packages/resources/machine` 实测 0 命中
  （收敛前为 **5 个文件 / 11 处**，其中 `file-picker-dialog` 的 2 处是运行时动态 `import()` 宿主组件与宿主 `api/fs`）。
  逐个文件的落点与覆盖下降说明：
  - `file-icon-helper-round39` / `file-icon-and-card-registry-pure` → `@fenix/ui-components/components/file-icon-helper`
    与 `/lib/card-renderer`；共享 `FileTypeIcon` 比宿主版本多一层尺寸容器，扩展名 / 颜色 / glyph 映射断言因此落在
    内层图标元素上（`fileIcon()` 辅助函数）。
  - `file-tree-model` → `@fenix/ui-components` **包根**：该模型的唯一公开出口是根 barrel，`web/components/file-tree-model`
    深路径实测 `Cannot find module`，不能写成深路径。
  - `file-tree-dialog`（改名 `file-tree-dialog.test.tsx`，与 `file-picker-dialog` 一致）→ `@fenix/ui-components` 包根的
    `FileTreeView` SSR 行为断言：工具条刷新优先、双分区与 `data-upload-target`、stale 横幅落在文件内容区内、
    空数据保分区与空态。覆盖下降四项（重命名 / 移动的字节数校验、弹窗 `maxLength`、节点级操作与右键菜单、
    宿主容器与 CSS）在文件头逐条记明 owner（宿主 `FileTreeTab.tsx` → §1.6；radix 门户与 arborist 在 SSR 下无输出）。
  - `file-picker-dialog` → `@fenix/ui-components` 包根的 `FilePickerPanel` + `FileInfo`：面板与视图类型已上收，
    宿主只剩「包进 Dialog + 补 `envId`」的会话入口（`apps/web/src/components/FilePickerDialog.tsx`）与 `apps/web/src/api/fs`
    网络层，两者归 §1.6；面板的目录加载在 mount effect 里跑，SSR 只覆盖首屏结构与注入契约。
  - `file-picker-round49-pure` → `@fenix/resource-mcp/web`（保留本分支的 `scope` + `access.actions` 授权语义）。
- **条件 3 的常驻守护**：`src/__tests__/machine-package-contract.test.ts`（由 `machine-source-migration.test.ts`
  就地改写并改名，与 prod-view 的同级契约测试命名对齐）已从「只断言文件存在与导出名」（计划 §7 风险 3 点名的假绿实例）
  补成包边界契约测试，扫描 `src` + `web` + `fenix.module.ts` + `package.json` + `README.md`：
  `@server` 零例外（原白名单「仅 `@server/db/schema`」随 B7 收口删除）、web 面无 `@/` 别名、无穿透包外的
  相对路径、src 生产代码不读 `process.env`（测试文件的夹具注入显式豁免）、跨包说明符命中对方声明的
  exports、路由文件互不导入（`dependencies.ts` 例外）、exports 键与目标、README 必需段式。

## 边界残留

- **`@server/**` 已清零（§1.7 B7，2026-09-22）**：§1.7 B1 迁出了本包自己的 `machine` / `registry_event`，现由
  `@fenix/resource-machine/db` 提供（`package.json` 的 `./db` 出口、`drizzle.config.ts` 的 schema 路径，
  DDL 零差异由 `bun run check:schema-ddl-drift` 守护）；B7 收口了最后一处跨模块表读取——`registry.ts` 对
  `agent_config` 的引用检查与绑定改经 owner 的公开入口（见「已知项」）。跨模块表读取不能简单改指对方的
  `./db`：§6.1 的组装期例外只覆盖 `db/**` 路径，`src/**` 的调用期跨模块表访问仍按 §2.3 判定，因此 B7 走的是
  owner 的 service 入口而非 schema 出口。另一条 `machine → sandbox`（写 `sandbox_instance`）已由 §1.7 B4
  前置消除——本包只通报机器注册 / 心跳事件，实现在 sandbox 侧。实测 `grep -rn 'from "@server' src/` → 0 条，
  `apps-boundary` 台账条目（按「本包不再引用 `@server/**`」的条件保留）随之删除。
- **需要编排者（共享文件 owner）落地的补丁**——以下文件不在本包目录内，本任务不写，缺一条就会出现运行期
  「工厂未注入守卫」或「导出名不存在」：
  1. `apps/server/src/main.ts`：`apiWorkspaceRoutes` 已不存在，改调 `createApiWorkspaceRoutes({ authGuardPlugin })`；
     WS 端点另行绑定 `FileWsPort`（现状经 `@fenix/resource-machine/server` 的具名导出，名字未变）。
  2. `apps/server/src/routes/web/index.ts`：`webFsRoutes` / `webFileEventsRoutes` / `webRegistryRoutes` 三个导入名
     已不存在，改调 `createWebFsRoutes({ authGuardPlugin })` / `createWebRegistryRoutes({ authGuardPlugin })` /
     `createWebFileEventsRoutes({ authenticateRequest })`——WS 升级不过 `sessionAuth` 宏，必须传宿主的显式认证入口。
     实测缺失名：`bun -e` 探针显示 `./server` 上缺 `apiWorkspaceRoutes` / `webFsRoutes` / `webFileEventsRoutes` /
     `webRegistryRoutes` 四个名字，工厂同名 `create*` 均存在。
  3. `apps/server/src/test-utils/setup-mocks.ts`：machine 模块配置基线改用本包 `/server/testing` 的
     `createMachineModuleConfig()`；`setRegistryRouteDeps` 已从 `./server` 移到 `/server/testing`（现状导入路径正确，
     但 `file-ws-handler` / `file-ws-requests` 的模块级替换要一并删除——替身已在包内 `/server/testing`）。
  4. `apps/server/src/schemas/index.ts:121`：`@fenix/resource-machine/server/schema` 的消费可改指包根
     `@fenix/resource-machine/server`（同一批 schema 已由 `src/server.ts:9` 转出），改完即可删除
     `exports["./server/schema"]`。
     本条原先还列了 `apps/server/src/schemas/api-workspace.schema.ts`——任务 1.3 已核实它是本包
     `src/schemas/api-workspace.schema.ts` 的字节重复、宿主零消费方，按「删除优于兼容」直接删除，
     因此剩下唯一消费方就是 barrel。
  5. `apps/web/src/api/registry.ts`：宿主副本删除，消费方（agent-config 的 `use-agent-editor.ts`、identity 的
     `AgentOrganizationsPage.tsx` 等组织机器页）改指 `@fenix/resource-machine/web`；agent-config 的 `package.json`
     需补 `@fenix/resource-machine` 依赖声明。
  6. `REGISTRY_SECRET` 的默认值 / 可覆盖断言归 agent-runtime：该变量由它的 `/acp/ws`、`/acp/ws/fs` 校验，本包已无
     读取点，包内两条断言随迁移删除（见 `src/__tests__/registry-schema.test.ts` 的注释）。1.7 C 块后该键的声明与
     默认值也在 agent-runtime 的 `fenix.module.ts`（宿主 schema 不再持有）；**不必再按键补断言**——模块声明的
     默认值、归一与非法值拒绝已由宿主 `apps/server/src/__tests__/assembly-env.test.ts` 对全部声明键统一覆盖。
  7. `apps/server/src/main.ts`：`initializeApplicationInfrastructure({ moduleConfigs })`（现状只登记 identity 与
     sandbox）增加本包条目 `machine: { defaultMachineId, fileWsIdentityStrict, fileEventsMaxClients }`。
     缺它时 `getMachineConfig()` → `getModuleConfig("machine")` 在请求 / 连接路径上抛「模块 machine 未声明应用
     基础设施配置」，registry-heartbeat / file-machine-events / file-events 三条路径直接不可用；本包不读
     `process.env`，这三个字段只能由宿主配置注入（形状校验用 `z.strictObject`，字段名写错立刻失败）。
  8. `apps/server/src/config.ts`：补 `fileEventsMaxClients: env.RCS_FILE_EVENTS_MAX_CLIENTS`（env 已在
     `apps/server/src/env.ts:132` 声明，默认 200），否则上一条的第三个字段没有来源。
     W2.5 复核现状（实测，非计划）：第 1、2、7、8 条已在磁盘落地——`main.ts:180-184` 的 `machine` 条目、
     `main.ts:489` 的 `createApiWorkspaceRoutes({ authGuardPlugin })`、`config.ts:59` 的
     `fileEventsMaxClients`、`routes/web/index.ts:11-14` 的三个 `create*` 工厂导入（47/48/53 行调用）；
     仍待落地的是第 3、4、5、6 条。
- **`package.json` 的 `./file-ws-*`（4 个）与 `./server/schema` 出口**：消费方是宿主 `setup-mocks.ts` 与
  `schemas/index.ts`，只能随上面第 3、4 条补丁一起删除，本任务保留。第 4 条落地前要注意一个反向代价：
  宿主 barrel 里的这些导入是**值导入**（zod schema），改指包根会把本包的整个 server 图拉进宿主的 schema
  barrel；`./server/schema` 的存在意义正是给这条路径留一个窄口，因此「删出口」与「改指包根」必须同批评估，
  不能只删出口——knowledge / mcp 两个包有同形状的 `./server/schema` 与同一批宿主消费点，三者应一起定夺。
- **反向边已消除（1.4，2026-09-20）**：`machine → sandbox`（1 处）与 `machine → agent-runtime`（9 处）已随
  「宿主运行态端口」落地清零，方向固定为 `sandbox → machine`、`agent-runtime → machine`；台账里的两条
  `special-dependency` 与一条 `no-circular` 同批删除。`dependsOn: ["agent-config"]` 现在是本包唯一的包间
  运行时依赖，B7 后代码证据有两处：`src/server/services/remote-file-service.ts` 值导入
  `getAgentConfigById` / `resolveAgentNode`，`src/server/services/registry.ts` 值导入
  `isAgentConfigBoundToMachine` / `bindMachineIdByAgentName`。
  **反向边消失不等于环消失**：B7 之后本包已无指向宿主的边（`@server/**` 归零，见「定位与 owner」与
  「边界残留」），但 `machine → agent-config` 这条矩阵内的边仍在——B7 只是把它从「直读对方表」改成「经对方
  `./server` 入口」，见证边未消失。台账里 machine 相关的 `no-circular` 条目因此仍有 **2 条真实违规**
  （实测 `python3 -c "import json;d=json.load(open('scripts/architecture/exceptions.json'));print([e['rule']
  for e in d['exceptions'] if e.get('from')=='@fenix/resource-machine'])"` → `['no-circular','no-circular']`），
  其 `removeWhen` 仍以「删除 `machine → agent-config` 反向边」为条件。本包名下其它规则的条目已一条不剩。

## 宿主运行态端口

本包不导入 `@fenix/agent-runtime`（1.4 起），它需要的三类**只存在于装配层**的能力改由端口注入，绑定语义与
agent-runtime 的 `bindCoreRuntimePort` 一致：装配阶段一次绑定（重复绑定报错），未绑定即失败、不隐式回退到本地
实现——回退会让宿主持有的运行态与包内看到的裂成两份。

| 端口 | 绑定方 | 提供的原语 |
|------|--------|-----------|
| `MachineHostPort`（`src/server/host-port.ts`） | 宿主 `apps/server` | workspace 根路径、Core runtime 节点查询 / 注销、file-ws 连接索引、断连清理 |
| `MachineEnvironmentPort`（`src/server/environment-port.ts`） | 宿主 `apps/server` | 环境记录读取与归属校验（实现仍在 agent-runtime） |
| `MachineSandboxRoutePort`（`src/server/sandbox-route-port.ts`） | `@fenix/resource-sandbox` | 「环境该路由到哪台机器」的沙盒判定（读 sandbox 自己的配置与池、实例表） |

`MachineSandboxRoutePort` 与另外两个的失败语义不同：**未装配返回 null**，调用方按「该 assembly profile 没有
沙盒能力」降级而不是报错——不含 sandbox 模块的部署里 `getRemoteMachineId` 必须照常走默认机器或本地 FS。

绑定发生在 `apps/server/src/main.ts`（前两个）与 `createSandboxModule()`（第三个）；测试侧宿主 preload 用同一
组绑定转发到 stub 注册表，包内用例另经 `setMachineHostPort` / `setMachineEnvironmentPort` 的浅合并替换层打桩。

## 守卫由宿主注入

`authGuardPlugin` / `authenticateRequest` **不是**本包的导出。Elysia 的 `macro` / `state` 是实例作用域的，父实例
无法向已构造的子实例回填；而守卫必须与宿主的认证解析（session cookie / Environment Secret / API Key 三条路径、
active organization 解析、限流）是同一份实例，两份同名实例会被 Elysia 按 plugin `name` 去重，先构造的一方静默生效。

因此 4 个路由都以**工厂**形式导出，由宿主注入守卫：

```ts
import {
  createApiWorkspaceRoutes,
  createWebFileEventsRoutes,
  createWebFsRoutes,
  createWebRegistryRoutes,
} from "@fenix/resource-machine/server";

const webFs = createWebFsRoutes({ authGuardPlugin });
const webFileEvents = createWebFileEventsRoutes({ authenticateRequest });
```

包内用例注入 `src/__tests__/guard-stubs.ts` 的替身（只提供工厂注册路由所必需的 `error` 装饰器、`user` /
`authContext` 槽位与 `sessionAuth` 宏，未认证时按宿主契约返回 401）；「路由 + 真实守卫」这条已发布合同的覆盖归
§1.5 的宿主用例，本包不重复断言（替身放行不等于合同已验）。

## 配置与 DB

本包不读 `process.env`、不读 `.env`，也不导入宿主配置模块：

- 配置经 `getMachineConfig()`（`getModuleConfig("machine")`，`src/server/config.ts`），形状校验用
  `z.strictObject`（宿主字段改名或拼错立刻失败）：`defaultMachineId`（`RCS_DEFAULT_MACHINE_ID`，缺省表示无兜底
  机器）、`fileWsIdentityStrict`（`RCS_FILE_WS_IDENTITY_STRICT`，默认宽松）、`fileEventsMaxClients`
  （`RCS_FILE_EVENTS_MAX_CLIENTS`，默认 200）。沙盒侧字段（`sandboxEnabled` / 默认池）不在本接口：环境是否落在
  沙盒里已由 sandbox 自己判定并经 `MachineSandboxRoutePort` 注入结果（见「宿主运行态端口」）。
- **读取必须发生在调用时**：配置在请求 / 连接路径上取值，模块加载期不读，避免装配顺序对基础设施初始化产生前置
  要求（`getModuleConfig` 在未初始化时抛错）。
- DB 经 `src/server/db.ts` 的 `getMachineDatabase()`（平台 `getDatabase()`），同样在调用时取句柄。
- `envDefinitions` 的宿主登记归 §1.7，manifest 不声明。

## 已知项

- **跨包表访问已全部闭环（原「跨包表访问残留（owner §1.4）」）**：本包曾直接读写两张不属于自己的表，两条都在
  §1.7 内闭环，不再有本包不修的跨包表访问：
  1. ~~`agent_config`（owner `@fenix/agent-config`）~~：**已闭环（§1.7 B7，2026-09-22）**。此前
     `registry.ts` 在删除机器前直读 `agent_config.machineId` 做引用检查，并在 `bindAgentConfigs` 里**写**该列，
     两条路径都没有对方公开 API（写路径尤其没有绑定入口）。B7 随表迁出补上两个 owner 入口：读走
     `isAgentConfigBoundToMachine(ctx.organizationId, id)`（`registry.ts:428`），写走
     `bindMachineIdByAgentName({ organizationId, agentName, machineId })`（`registry.ts:474` 的
     `bindAgentConfigs` 转调）。本包只表达「这台机器还能不能删」「把上报的 `agentName` 绑到这台机器」两个业务
     意图，不再自己解释 `machine_id` 列、也不在本包重写归属条件。
  2. ~~`sandbox_instance`（owner `@fenix/resource-sandbox`）~~：**已闭环（§1.7 B4 前置，2026-09-22）**。
     本包此前经 `src/server/services/machine-sandbox-projection.ts` 直接 UPDATE `sandbox_instance`，把机器注册 /
     心跳投影为实例状态；该表归 sandbox 后这条路径成为 §2.3 的 `machine → sandbox` 写路径，而 §6.1 的组装期例外
     只覆盖 `db/**`、本文件在 `src/server/services/` 下不适用。按 §4.8 第 3 条的裁定，**投影写路径移到 sandbox
     侧**：本包改为经 `machine-lifecycle-port.ts` 通报事件（`notifyMachineRegistered` / `notifyMachineHeartbeat`），
     由 `@fenix/resource-sandbox` 在 `createSandboxModule()` 注入实现在自己表上写（方向 sandbox → machine，
     与该包已有的 `MachineSandboxRoutePort` 同形）。本包 `src/**` 不再有**写** `sandbox_instance` 的代码路径
     （2026-09-22 实测：`grep -rn sandbox_instance src` 共 5 行命中，全部是注释与断言文本——`machine-lifecycle-port.ts`
     文件头的历史说明 2 行、`machine-resource-surface.test.ts` 的反向守卫说明、`machine-package-contract.test.ts`
     的迁移注记、`remote-file-service.test.ts` 的用例注释；生产代码 0 行）。
- **service 直连 DB 未收敛**：`getMachineDatabase()` 的调用点除 3 个 repository 外，还有 3 个 service
  （`registry.ts` / `registry-heartbeat.ts` / `remote-file-service.ts`），B7 后 3 个 service 合计 28 处
  （逐个文件跑 `grep -c "getMachineDatabase("` → 26 + 1 + 1），其中 `registry.ts` 一个文件 26 处——B7 前为
  30 处与 28 处，差额是 `registry.ts` 里直读 / 直写 `agent_config.machineId` 的两处改为调用 owner 入口。
  收敛到 repository 属 §1.4 的边界收敛范围；新增数据库操作一律进 repository，不要沿这条路径继续扩散。
- **`src/server/routes/web/fs.ts` 627 行**：超出单文件 500 行约束；§三 裁决文件域留在 machine，拆分落点与时机未定。
- **`@fenix/ui-components` 目前只在 `devDependencies`**：本包的 5 个 web 用例（图标 / 文件树 / 文件选择面板）
  断言的是共享 UI 包的公开入口（`components/file-icon-helper`、`lib/card-renderer`、包根的文件树视图与选择面板、
  `ui/dialog`），生产代码尚未引用；文件域组件（文件树 / 文件选择器 / 文件图标）随 §1.6 迁入后需升级为 `dependencies`。
- **`@fenix/resource-mcp` 是 `devDependencies`（仅测试用）**：`file-picker-round49-pure` 断言的是对方授权视图
  助手的消费面，不是本包生产依赖。
- **`src/server/__tests__/file-ws-events.test.ts` 首例存在约 0.2%/次的既存竞态**（非本次引入：该断言与
  `HEAD` 逐字一致，仅用例头部导入在本任务中改过）：用例在 `register` 后立即订阅并只等 10ms，而 `register`
  触发的 `invalidate_all` 分发带 `INVALIDATE_JITTER_MAX_MS = 5_000` 的随机抖动，抖动落进等待窗口时
  `frames` 会多出一条失效帧。实测 4 次全量运行命中 1 次（当时与 `tsc --noEmit` 并发抢 CPU，计时器后延会放大
  命中面），随后连续 3 次全绿。加固方式是把断言收敛为 `f.type === "file_changed"`（同文件其余用例已在用
  该写法），属后续顺手项，不在本任务范围。
- **测试替身与宿主 preload 的关系**：包内用例不接受宿主 `@server/test-utils/*`；宿主 preload
  （`bunfig.toml [test] preload`）对所有 `bun test` 生效，因此包内基础设施初始化必须走
  `initializeMachineModuleConfig()`（复位替身后经生产读取路径初始化，并用 DB 转发代理保证用例内的 `stubDb()`
  仍然生效）。
