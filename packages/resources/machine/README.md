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
`repositories/machine-repository.ts` 的实现。反方向同理：本包要看 Agent 配置的执行节点或改写机器绑定，
经自己声明的 `MachineAgentConfigPort`（2026-09-24 E1 起，见「宿主运行态端口」），由宿主绑定 agent-config
的实现。消费方**不得**导入本包的表对象（§2.2 / §2.3：组装期例外只在各包 `db/` 内成立），也**不得**直接
导入本包的公开入口——本包 `dependsOn` 已含 `agent-config`（本包的取数实现需要它已装配），
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
  声明 `contributions`（1.5e / 1.5f，四条 `app-route`：三条挂 `web`、一条挂 `api`，见 `fenix.module.ts`）；不声明 `web`：消费方是 §1.6 的 WebShell 装配，形状需与消费端同时定型。
- **测试装配**：`/server/testing` 提供 `createMachineModuleConfig` / `initializeMachineModuleConfig` /
  `stubMachineConfig` / `stubMachineEnvironment(Record)` / `stubMachineAgentConfig` / `stubFileWsTransport`
  与三个句柄替换入口（lifecycle / heartbeat / registry 路由）；
  包内用例另用 `src/__tests__/guard-stubs.ts` 注入守卫替身。`stubMachineAgentConfig` 必须显式给出三个原语：
  端口是整体契约，未绑定即失败——用例不能依赖测试专用的默认值，否则「未装配」会在用例里静默通过。

## web 面与 i18n

- **浏览器出口**：`web/index.ts`（`package.json` 的 `exports["./web"]` 指向它），导出面 = 机器注册表客户端
  （`web/api/registry.ts` 的 `registryApi` 与记录 / 查询 / 响应类型）+ 文件域客户端 `web/api/fs.ts`
  （`fsApi`、上传 / 下载 / 预览源读取与 `MAX_UPLOAD_*` 常量）+ 文件变更事件通道
  （`web/api/file-events.ts`：`/web/file-events` 的 WS URL、订阅帧与帧归一）+ 文件域容器
  （`web/components/FileTreeTab.tsx`、`web/components/FileTabsBar.tsx`、`web/components/artifacts-files-workspace.tsx`）
  + 编排 hook（`web/hooks/use-file-uploads.ts`、`use-artifacts-files.ts`、`use-file-tree-events.ts`）与纯工具
  （`web/lib/normalize-to-user-path.ts`、`web/lib/random-uuid.ts`）。全部 2026-09-24 随台账
  `ce-standards-todo.md` D2 由宿主 `apps/web/src/api/{fs,file-events}.ts` 与
  `apps/web/src/shell/artifacts/{FileTreeTab,FileTabsBar,artifacts-files-workspace,use-artifacts-files,use-file-tree-events}.tsx`
  迁入（该簇 2026-09-28 归位到 `apps/web/src/pages/agent-panel/artifacts/`，上述文件都不在其中；同一批的
  `use-drag-counter.ts` 只服务包内两个调用点，按「没有第二个消费者就不导出」不转出）。
  跨包消费方（agent-config 的 Agent 编辑器、identity 的组织机器页、宿主的 artifacts 面板与聊天取件入口）
  取用的就是这一份，必须走包根 `@fenix/resource-machine/web`——`web/api/registry` 这类
  深层路径会把本包的内部目录变成事实契约。
- **浏览器面守卫**：`web/__tests__/machine-browser-surface.test.ts` 静态走值导入图（`web/__tests__/value-import-graph.ts`），
  跨包说明符经对方 `exports` 递归进入；白名单 18 条——宿主注入的 peerDependency（`react` / `react-dom` /
  `react-i18next`）、本包直接依赖的浏览器库（`ahooks` / `lucide-react` / `sonner`）与经 `@fenix/ui-components`
  子路径传递进入的库（radix 原语、`clsx` / `tailwind-merge` / `class-variance-authority`、`react-file-icon` /
  `react-arborist` / `react-resizable-panels`、`@open-file-viewer/*`），每条在测试文件里带收录理由；
  另含负例注入（`@fenix/resource-machine/server` 必须被拦下）与「相对路径不得越界到 `apps/web`」一条。
- **i18n 自持 `machine` 命名空间**（键的最终所在地 = 包的 owner）：`web/i18n/namespace.ts` 持 `MACHINE_NS` 常量、
  `web/i18n/index.ts` 持 `locales/{en,zh}/machine.json` 资源，经 `exports["./web/i18n"]` 公开、不经根入口转出
  （宿主 i18n 引导在启动期求值，根入口会把整个 web 面拉进首屏）。当前 24 键：`filePicker.fileTooLarge` 与
  `fileTree.{uploadFailed,uploadPartialIndeterminate}` 随上传 hook 迁入；`fileTree.{renameFailed,moveFailed,
  mkdirFailed,newFileFailed,downloadFailed,closeTab,moreTabs,dialog.*,contextMenu.delete}` 与
  `changedFiles.title` 随文件树容器与 tab 栏迁入（中文键的消费方只剩本包）。宿主 `components.fileTree` 保留的
  `emptyState` / `emptyHint` / `userEmptyState` / `retry` / `staleBanner` 是同名键在 `uiComponents` 命名空间
  已另有一份（消费方是 `@fenix/ui-components` 的文件树视图），`dropToUpload` / `uploadTo` 的消费方是宿主面板
  自己的拖拽遮罩——它们不随迁，否则会在包字典里变成死键（`web/__tests__/machine-i18n.test.ts` 双向断言）。
  宿主 `apps/web/src/i18n/index.ts` 已按 `MACHINE_NS` 登记；`MACHINE_NS` 的字面量在本包声明
  （中心表 `@fenix/web-runtime/i18n/namespace` 尚未收录，同 sandbox 先例），待中心表补齐后改用 `NS.MACHINE`。
  **订正**：本段此前记「本包没有自持命名空间，因此不建 `web/i18n/**`」——其前提是「没有需要迁出的寄居键」，
  D2 迁入上传 hook 后该前提失效，字典按 §9.2 落位。
- **测试归属（W2.5 收敛后）**：`web/src/__tests__/` 的 6 个文件全部改为对**共享实现公开入口**的消费方断言，
  不再有一处穿透到 `apps/web`：`grep -rnE '\.\./\.\./\.\./.*apps/web' packages/resources/machine` 实测 0 命中
  （收敛前为 **5 个文件 / 11 处**，其中 `file-picker-dialog` 的 2 处是运行时动态 `import()` 宿主组件与宿主
  `api/fs`——该客户端现已归本包 `web/api/fs.ts`，见 D2）。
  逐个文件的落点与覆盖下降说明：
  - `file-icon-helper-round39` / `file-icon-and-card-registry-pure` → `@fenix/ui-components/components/file-icon-helper`
    与 `/lib/card-renderer`；共享 `FileTypeIcon` 比宿主版本多一层尺寸容器，扩展名 / 颜色 / glyph 映射断言因此落在
    内层图标元素上（`fileIcon()` 辅助函数）。
  - `file-tree-model` → `@fenix/ui-components` **包根**：该模型的唯一公开出口是根 barrel，`web/components/file-tree-model`
    深路径实测 `Cannot find module`，不能写成深路径。
  - `file-tree-dialog`（改名 `file-tree-dialog.test.tsx`，与 `file-picker-dialog` 一致）→ `@fenix/ui-components` 包根的
    `FileTreeView` SSR 行为断言：工具条刷新优先、双分区与 `data-upload-target`、stale 横幅落在文件内容区内、
    空数据保分区与空态。覆盖下降四项中的三项在文件头逐条记明 owner（弹窗 `maxLength`、节点级操作与右键
    菜单、容器交互需要的 DOM 环境）；「重命名 / 移动的字节数校验」那一项已随 D2 的容器迁入归位：
    `web/__tests__/file-tree-name-validation.test.ts` 断言三个纯函数的 UTF-8 字节上限与非法字符口径。
  - `file-picker-dialog` → `@fenix/ui-components` 包根的 `FilePickerPanel` + `FileInfo`：面板与视图类型已上收，
    宿主只剩「包进 Dialog + 补 `envId`」的会话入口（`apps/web/src/pages/agent-panel/FilePickerDialog.tsx`），
    其网络层自 D2（2026-09-24）起取自本包 `web/api/fs.ts`；面板的目录加载在 mount effect 里跑，
    SSR 只覆盖首屏结构与注入契约。
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
- **反向边已全部消除（1.4 + E1）**：`machine → sandbox`（1 处）与 `machine → agent-runtime`（9 处）随
  1.4 的「宿主运行态端口」清零，方向固定为 `sandbox → machine`、`agent-runtime → machine`；台账里的两条
  `special-dependency` 与一条 `no-circular` 同批删除。`machine → agent-config`（§2.3 矩阵外的反向边，也是
  4 包环族的共同闭合边）随 2026-09-24 E1 清零：`remote-file-service.ts` 的 `getAgentConfigById` /
  `resolveAgentNode` 与 `registry.ts` 的 `isAgentConfigBoundToMachine` / `bindMachineIdByAgentName` 改经本包
  声明的 `MachineAgentConfigPort`（宿主装配注入，见「宿主运行态端口」），本包源码对 `@fenix/agent-config`
  的引用数为 0（实测 `grep -rn '@fenix/agent-config' src/ fenix.module.ts` 仅剩注释文本；
  `machine-package-contract.test.ts` 的「包内不引用 agent-config 的入口」用例常驻守护）。**环**随之消解：
  agent-config ↔ agent-runtime ↔ machine ↔ sandbox 这一族不再闭合，台账里 machine 与 agent-config 名下的
  6 条 `no-circular` 条目同批删除（`removeWhen` 写的正是这条边）。新禁则由架构门禁的
  `special-dependency` 规则承担——§2.3 的 machine 行禁止依赖其他 `resources/*` 包，矩阵与门禁同批补齐。

## 宿主运行态端口

本包不导入 `@fenix/agent-runtime`（1.4 起）、不导入 `@fenix/agent-config`（E1 起）：它需要的**只存在于装配层
或对方模块**的能力改由端口注入，绑定语义与 agent-runtime 的 `bindCoreRuntimePort` 一致：装配阶段一次绑定
（重复绑定报错），未绑定即失败、不隐式回退到本地实现——回退会让宿主持有的运行态与包内看到的裂成两份，或
让「取不到」与「确实没有」混成一种结果。

| 端口 | 绑定方 | 提供的原语 |
|------|--------|-----------|
| `MachineHostPort`（`src/server/host-port.ts`） | 宿主 `apps/server` | workspace 根路径、Core runtime 节点查询 / 注销、file-ws 连接索引、断连清理 |
| `MachineEnvironmentPort`（`src/server/environment-port.ts`） | 宿主 `apps/server` | 环境记录读取与归属校验（实现仍在 agent-runtime） |
| `MachineAgentConfigPort`（`src/server/agent-config-port.ts`） | 宿主 `apps/server` | Agent 配置的执行节点读取（带组织归属）、机器引用检查、机器注册绑定（实现来自 agent-config） |
| `MachineSandboxRoutePort`（`src/server/sandbox-route-port.ts`） | `@fenix/resource-sandbox` | 「环境该路由到哪台机器」的沙盒判定（读 sandbox 自己的配置与池、实例表） |

`MachineAgentConfigPort` 与 `MachineHostPort` / `MachineEnvironmentPort` 的差别在**实现来源**：前两者的实现是
宿主的进程级单例（包内无法持有第二份），本端口的实现是 owner（`@fenix/agent-config`）的公开入口——宿主只做
适配（`apps/server/src/services/machine-agent-config-port.ts`），因为「执行节点怎么解析」「哪条配置算绑在这台
机器上」是对方的领域规则，本包只表达业务意图。`getExecutionNode` 的入参必带 `organizationId`：机器文件路径
不得因「环境绑定的配置 ID 撞上」而按别的组织声明的节点路由（§10.3 多租户隔离）。

`MachineSandboxRoutePort` 与另外三个的失败语义不同：**未装配返回 null**，调用方按「该 assembly profile 没有
沙盒能力」降级而不是报错——不含 sandbox 模块的部署里 `getRemoteMachineId` 必须照常走默认机器或本地 FS。

绑定发生在 `apps/server/src/bootstrap/host-wiring.ts`（前两个）、`host-startup.ts`（第三个：与 agent-config 的
另两个端口放在一起，`host-wiring` 刻意不导入 agent-config 的入口）与 `createSandboxModule()`（第四个）；测试侧
宿主 preload 用同一组绑定转发到 stub 注册表（前两个），包内用例另经 `setMachineHostPort` /
`setMachineEnvironmentPort` / `stubMachineAgentConfig` 的浅合并替换层打桩。

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
  1. ~~`agent_config`（owner `@fenix/agent-config`）~~：**已闭环（§1.7 B7，2026-09-22；E1 收口取数方向，
     2026-09-24）**。此前 `registry.ts` 在删除机器前直读 `agent_config.machineId` 做引用检查，并在
     `bindAgentConfigs` 里**写**该列，两条路径都没有对方公开 API（写路径尤其没有绑定入口）。B7 随表迁出补上
     两个 owner 入口：读走 `isAgentConfigBoundToMachine(ctx.organizationId, id)`、写走
     `bindMachineIdByAgentName({ organizationId, agentName, machineId })`；E1 再把这两处与
     `remote-file-service.ts` 的执行节点读取一起改为经本包声明的 `MachineAgentConfigPort`（宿主注入 owner 的
     实现），本包源码因此不再引用 agent-config 的任何出口。本包只表达「这台机器还能不能删」「把上报的
     `agentName` 绑到这台机器」「这个环境该走哪台机器」三个业务意图，不解释 `machine_id` 列、不重写节点解析
     优先级、也不在本包重写归属条件。
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
- **`/api` 工作区上传与 `/web` 文件上传仍是同一个动作的两套实现（§3.1 的薄 adapter 未收敛）**：两条链路的
  业务动作相同（把 multipart 文件写进某个 environment 的 workspace），等价部分为「经 `resolveWorkspacePath`
  解析同一个 workspace 根 + 拒绝 `..` 越界 + 落盘前 symlink 防护」，但**对外契约与语义有实质差异**，在拿到
  裁定前不得强行合并（合并任一侧都会改变已发布 `/api` 合同的可见行为）：
  1. **路径作用域**：`/api` 只接受 `user/` 子树（`api-workspace.ts` 的 `normalizeUserRoutePath` + `isUserPath`，
     越界 400）；`/web` 自 F1 起允许 workspace 根内任意路径（`file-path-validator.assertSafePath`）。
  2. **远程落点**：`/api` 发往机器前剥掉 `user/` 前缀，`/web` 原样下发——同一条逻辑路径在远程机器上落到两个
     不同目录；`/api` 的响应再把机器返回的路径重新标成 `user/...` 掩盖了这个差异。
  3. **单文件上限**：`/api` 本地 50MB；`/web` 本地 100MB / 远程 20MB（`file-types.ts` 的能力上限不对称条款）。
     远程分支最终都受 `remote-file-service.ts` 的 20MB 约束，本地分支的阈值确实不同。
  4. **授权口径**：`/api` 只按组织 + 属主（`machine-workspace-facade` 不下传角色）；`/web` 下传角色，
     `member` 一律 403（`machine-file-facade`）。这两条口径都是既有行为，收敛时必须先裁定取哪一条。
  5. **幂等与副作用**：`/web` 支持 `opId` 幂等键与 `If-Match` 条件写，并在本地写成功后发布 `file_changed`
     事件（订阅方据此刷新）；`/api` 两者都没有，本地写入不广播变更事件。
  6. **相对路径校验**：`/api` 自带一份校验（拒绝反斜杠、NUL、绝对路径与 `..`），`/web` 走共享的
     `file-path-validator`（`\` 与 `/` 同视为分隔符、拒绝控制字符与超长单段）——同一份 `relativePaths` 在两侧的
     接受集合不同。
  7. **错误信封**：`/api` 用平台契约的 `{ error: { code, message } }`（`routes/api/workspaces.ts` 的 `mapApiError`
     只认 `AppError` 的 `statusCode` + `code`）；`/web` 用 `{ error: { type, message } }`（按
     `FileServiceError.type` 映射）。
  - **owner**：两面都在本包（`src/server/services/api-workspace.ts` 与
    `agent-file-service.ts` + `file-backends.ts`）；其中 `/api` 一面是已发布的外部合同。
  - **现状依据**：`docs/arch/12-files.md` §2.4 表注明「`/api/*` 文件面（`api-workspace.ts`）收敛到本契约时
    另行评估」、§10 二期清单列「`/api/*` 第三套实现的收敛评估」；按 §3.1，已发布 `/api` 合同的变更或退役必须
    经独立 ADR、消费者盘点和迁移窗口，因此当前不做收敛，证据与建议已交主控裁定。
  - **移除条件**：主控给出「并入文件域 Facade」的裁定与迁移窗口后，`routes/api/workspaces.ts` 改为调用
    `machine-file-facade`（协议形状与错误码在 adapter 内保持），`services/api-workspace.ts` 的第二套写入、
    校验与上限逻辑整体删除；届时本条与 `workspace-fs.ts` 里 `isUserPath` / `normalizeUserRoutePath` 的
    「对外契约」保留注记一并评估。
- **`src/server/routes/web/fs.ts` 627 行**：超出单文件 500 行约束；§三 裁决文件域留在 machine，拆分落点与时机未定。
  web 侧客户端已随 D2（2026-09-24）归位本包 `web/api/fs.ts`；同批（D2 第二批）文件树容器、tab 栏、文件工作区
  与事件通道客户端也迁入 `web/**`，宿主侧只剩跨包装配（`apps/web/src/pages/agent-panel/artifacts/` 的 `ArtifactsPanel` /
  `TopModeTabs` / 站点绑定对话框——站点与任务来自 agent-config 与 task，machine 不得导入）。
- **`@fenix/ui-components` 已从 `devDependencies` 升为 `dependencies`**（2026-09-24，D2 第二批）：文件域组件
  （文件树容器、tab 栏、文件工作区）迁入后，生产代码经该包公开入口取用文件树视图、预览 tab、分栏与基础原语。
  同批新增的普通浏览器库（`ahooks` / `lucide-react` / `sonner` / `react-resizable-panels`）与既有测试用
  `@fenix/resource-mcp` 的分工不变：前者进 `dependencies`，后两者（`@fenix/resource-mcp`）只在 `devDependencies`。
- **`@fenix/agent-config` 仍是 `dependencies` 里的未引用项**：E1（2026-09-24）把本包的取数改为宿主注入的
  `MachineAgentConfigPort` 后，`src/**` 与 `web/**` 已零导入（`src/__tests__/machine-package-contract.test.ts`
  的「包内不引用 agent-config 的入口」断言把这一点钉住）；按 §2.1「`dependencies` 里没有任何导入的条目必须删除」
  应删除，但本包的 `dependsOn: ["agent-config"]`（装配顺序需要它在先）是另一条独立声明，删除依赖声明与它无关，
  属台账未列出的收尾项，**移除条件**：确认无消费方依赖本包携带该编译期边后删除。
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
