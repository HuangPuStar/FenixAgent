# @fenix/resource-machine

RCS machine（远程机器）的注册与心跳、Agent 进程路由、file-ws 传输与 workspace 文件域的唯一 owner。

## 职责

- **机器注册表**（`src/server/services/registry.ts`）：`machine` 与 `registry_event` 的唯一写入点。管理面走 `listMachines` / `getMachine` / `createMachine` / `updateMachine` / `deleteMachine` / `listEvents`；连接侧 `registerMachine` 只激活运行时状态（未预创建的机器直接拒绝，不再支持自动注册），`disconnectMachine` / `markHeartbeatTimeout` / `updateHeartbeat` 同样不写元数据字段。沙盒侧预创建走 `createSandboxMachine` / `deleteSandboxMachine`（只作补偿清理），进程启动时 `resetAllMachinesOffline()` 复位残留 online。
- **心跳与巡检**（`registry-heartbeat.ts`）：`startHeartbeat` / `handleHeartbeat` 按 3 倍心跳间隔判超时，`startMachineSweep`（默认 60s）把 DB 记 online 但对不上活跃 WS 的机器收敛为 offline 并触发 relay 清理；两者是进程级定时器，随连接生命周期 `stop*`。
- **连接等待**（`machine-connection-waiter.ts`）：`waitForMachineConnection` 以共享 DB 轮询（1s 起、线性退避）等待回连，超时或 `AbortSignal` 抛出 `MachineConnectionTimeoutError`；sandbox 的执行入口据此寻址机器。
- **文件域**：`src/server/services/agent-file-service.ts` 是门面（本地/远程路由与统一错误映射），`file-backends.ts` 是执行后端（`LocalBackend` 包 `workspace-fs`、`RemoteBackend` 包 `remote-file-service`），`workspace-fs.ts` 负责路径解析与 realpath 越界防护；远端经 file-ws 传输（`transport/file-ws-*` 与 `file-op-retry` 的重试熔断），20MB 上传/zip 上限与 413 文案的权威声明在 `file-types.ts`，`remote-file-service.ts` 为避免模块互引成环另有一份，改值必须两处同步（测试断言锁定）。
- **状态投影与运行时释放**：`machine-sandbox-projection.ts` 把机器注册/心跳投影到 `sandbox_instance`（sandbox 经本包读该状态，不自行监听机器事件）；`machine-runtime.ts` 的 `releaseMachineRuntime` 经 agent-runtime 宿主端口注销远端节点。
- **本地节点**：`src/services/local-node-service.ts` 的 `LocalNodeAwareService` 为 `local-default` 提供常驻在线的 stub AgentNode，其余 machineId 原样委托真实节点服务。
- **HTTP 交付物**：`/web/registry/machines[/:id][/events]`、`/web/environments/:id/fs/*`（tree/list/read/write/upload/delete/mkdir/rename/batch/download-zip）、WS `/web/file-events`、`/api/environments/:environmentId/workspace/files`，全部由 `src/server.ts` 的 default export 暴露、宿主挂载。
- **模块描述符**：`fenix.module.ts` 只声明 `id: "machine"` / `kind: "resource"` / `dependsOn` / `capabilities`；组合根 `src/module.ts` 与 `create` 工厂留到 W2 切片。

## 依赖边界

- `dependsOn: ["agent-config"]` 的代码证据只有一处：`src/server/services/remote-file-service.ts` 值导入 `getAgentConfigById` / `resolveAgentNode` 解析 AgentNode。机器侧不重复实现 Agent 配置读取。
- **不声明 `sandbox`**：同一文件值导入 `@fenix/resource-sandbox/server` 的 `findActiveSandboxInstance` / `findReadableSandboxPoolById`，与 §2.3 固定的 `sandbox → machine` 方向相反。该边已登记为台账 `special-dependency`（owner 1.4，须消除）；写进 `dependsOn` 会被生成器以「已由架构台账登记为越界边，不能编码成装配依赖」拒绝，两者同时启用时装配顺序也会因循环失败。
- **不声明 `agent-runtime`**：生产代码 9 处值导入（`event-service.ts` 的 EventBus 薄封装、`machine-runtime.ts` 的 `getBoundCoreRuntimePort`、`workspace-fs.ts` 的 `resolveWorkspacePath`、`registry-heartbeat.ts` 的动态 `import()` 等），方向固定为 `agent-runtime → machine`，同属 owner 1.4 的 `special-dependency`。
- **不声明 `orchestration`**：`@fenix/orchestration` 没有 manifest、不属 `resource` 类别（`LocalNodeAwareService` 只实现其 `AgentNodeServicePort`），不参与资源包装配顺序。
- 身份数据经 `@fenix/platform-sdk` 窄契约取得（`getIdentityDirectory().getOrganization()` 校验组织默认引擎引用），不直查 `organization` 表。
- 包侧仍有 29 处 / 15 个生产文件读 `@server/**`（DB、config、env、认证插件与宿主类型），台账 `apps-boundary` owner 1.4（removeWhen：Machine 只暴露 Runtime 所需的专用公开运行入口）。

## 守卫由宿主注入

当前形态与目标形态不同，改动前必须知情：

- 本包路由是 `export default app` 且**直接导入宿主守卫**：`routes/web/fs.ts`、`routes/web/registry.ts`、`routes/api/workspaces.ts` 使用 `authGuardPlugin`，`routes/web/file-events.ts` 的 WS `open` 调用 `authenticateRequest()`。因此「守卫必须与宿主认证解析是同一份实例」这条不变量目前靠「唯一实现」满足，而不是靠注入。
- 本包不导出守卫插件，也没有 Elysia `macro` / `state` 替身。
- 测试接缝：路由依赖替换经 `@fenix/resource-machine/server/testing` 的 `setRegistryRouteDeps()`，不进生产 `./server` 出口；心跳服务另有 `setRegistryHeartbeatDeps()`（随 `./server` 导出）。包内用例仍直接 import 宿主的 `setTestAuth` / `stubEnvironmentRepo`，这条残留归 W2 每包切片。
- 目标形态（工厂 + 守卫注入，参照 sandbox 样本）与 manifest 的 `contributions` / `web` 一并留到 W2 与 §1.5 / §1.6 定型，避免单方面发明形状后返工。

## 配置与 DB

- 没有包内 DB 句柄：3 个 repository 与 `registry` / `registry-heartbeat` / `remote-file-service` / `machine-sandbox-projection` 直接 `import { db } from "@server/db"`，并读 `@server/db/schema` 的 `machine` / `registry_event` / `agent_config` / `sandbox_instance` 表。表定义迁出归 §1.7，本任务按裁决保留 `@server/db/schema` 作显式残留。
- 配置直读宿主：`remote-file-service.ts` 读 `config.sandboxEnabled` / `defaultSandboxPoolId` / `defaultMachineId`，`file-machine-events.ts` 读 `config.fileWsIdentityStrict`（W11 严格模式），`routes/web/file-events.ts` 在 WS `open` 回调内取 `validateEnv().RCS_FILE_EVENTS_MAX_CLIENTS`（默认 200，`DEFAULT_FILE_EVENTS_MAX_CLIENTS` 为同值常量）。
- **读取发生在调用时**：env 与 config 都在请求/连接路径上取值，模块加载期不读，避免装配顺序对基础设施初始化产生前置要求。
- `envDefinitions` 的宿主登记归 §1.7，manifest 不声明。

## 边界外的已知项

- **没有浏览器出口**：`package.json` 无 `./web` 条目，`src/index.ts` 是空壳（`export {}`）；`web/` 下只有 `web/src/__tests__/` 的 6 个测试文件，且以相对路径直引 `apps/web/src/**`（`FilePickerDialog`、`FileTreeTab`、`file-tree-model`、`file-icon-helper`、`api/fs`、`types`）与 `@/src`、`@/components` 别名，台账 `web-package-not-to-app` owner 1.6（15 处 / 6 文件）。页面、API client 与 i18n 出口整体归 §1.6。
- **没有 `src/module.ts` 单例**：模块组合根与 manifest 的 `create` 工厂属 W2 切片。
- **路由未工厂化**：default export + 守卫直连形态归 W2；route contribution 由宿主挂载归 §1.5。
- **表定义与 DB 句柄仍在宿主**：`@server/db/schema` 归 §1.7；`apps-boundary` 台账 owner 1.4。
- **反向边待消除**：`machine → sandbox`（1 处）与 `machine → agent-runtime`（9 处）由 owner 1.4 收敛，方向固定为 `sandbox → machine`、`agent-runtime → machine`；消除前两者都不能写进 `dependsOn`。
- **`src/routes/web/fs.ts` 622 行**：超出单文件 500 行约束；§三 裁决文件域留在 machine，拆分落点与时机未定，本任务不动。
