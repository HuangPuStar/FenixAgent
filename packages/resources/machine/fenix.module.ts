import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { z } from "zod/v4";

/**
 * Machine 资源模块描述符。
 *
 * 远程机器（RCS machine）的注册与心跳、Agent 进程路由、file-ws 传输与 workspace 文件域的唯一 owner。
 * 装配面上的消费者是宿主 `apps/server`（注册 machine 路由与 file-ws 接入、启动心跳清扫）与
 * `@fenix/resource-sandbox`（执行请求等待机器回连后寻址）。
 *
 * `dependsOn: ["agent-config"]`：**声明的是装配顺序与 profile 闭包，不是导入边**。本包此前有两个文件经
 * `@fenix/agent-config/server` 取数——`src/server/services/remote-file-service.ts` 读 Agent 配置并解析
 * AgentNode、`src/server/services/registry.ts` 做机器删除的归属校验与机器绑定写入（1.7 B7 从直读
 * `agent_config` 表收敛而来）。这条反向边不在 §2.3 的依赖矩阵里，靠台账 `no-circular` 冻着，且它与
 * agent-config → agent-runtime、agent-runtime → sandbox、sandbox → machine 三条边共同闭合 4 包环族；
 * 2026-09-24 起两处取数改经本包声明的窄端口 `MachineAgentConfigPort`（`src/server/agent-config-port.ts`）
 * 由宿主 `apps/server` 注入实现，**本包已无任何 agent-config 导入**（禁则由 `special-dependency` 的
 * machine → resource 规则强制）。
 *
 * 保留 `dependsOn` 的理由：宿主注入的实现等价于 agent-config 的系统入口，需要该模块已装配；这条声明让
 * profile 闭包把 agent-config 一起启用，而不是等运行期才暴露。方向仍是 agent-config → machine 之外的单向
 * ——本包不导入它、不写它的表，`dependsOn` 只表达「先装配谁」。
 *
 * 装配契约（1.4 起）：本包不再导入 `@fenix/agent-runtime`，宿主运行态（workspace 根、Core runtime 节点、
 * file-ws 连接索引、断连清理）与 environment 读取改由 `apps/server` 经 `bindMachineHostPort` /
 * `bindMachineEnvironmentPort` 在装配阶段注入；`@fenix/resource-sandbox` 则在自己的模块装配时经
 * `bindMachineSandboxRoutePort` 注入沙盒路由判定。因此 `sandbox → machine` 与 `agent-runtime → machine`
 * 保持单向，两条反向边（旧台账 `special-dependency`，owner 1.4）已随本任务消除。
 *
 * `create`：惰性组合根（`src/module.ts` 的 `createMachineModule()`），模块索引层只 import 本文件，装配期
 * 再按需加载 `./server` 图——file-ws 连接索引、心跳巡检与事件队列都是进程级单例，装配只能从这一处进入。
 *
 * 声明 `contributions`（1.5e）：`/web/environments/:id/files/*`、`/web/file-events`、`/web/machines` 三条
 * 路由实例由本模块以惰性构造函数 `(host) => import("./src/server/assembly").then(...)` 给出，
 * `slot: "web"` 指明挂宿主 `/web` 聚合面——路由路径是相对形式，前缀由宿主的聚合实例决定，「挂哪一面」
 * 只能由声明说清。`/web/file-events` 是 WS 升级、不走 `sessionAuth` 宏，它从同一份宿主协议面取显式认证
 * 入口（`authenticateRequest`）。惰性 import 与 `create` 同因：registry 会被大量位置导入，不能在索引层就
 * 把 Elysia 拖进模块图。
 *
 * 1.5f 追加一条 `api` 槽贡献：`/api/environments/:environmentId/workspace/files`（对外工作区文件接口，
 * 与 `/web` 面共用同一份会话守卫）。
 *
 * 声明 `envDefinitions`（1.7 C 块，路线 A）：本包实测只有两个部署级变量，且都只被本模块消费——
 * `RCS_FILE_WS_IDENTITY_STRICT`（file-ws `register` 帧的身份绑定严格模式，默认宽松）由
 * `src/server/services/file-machine-events.ts` 在未知 machine 的 register 上判定是否 close(4404)；
 * `RCS_FILE_EVENTS_MAX_CLIENTS`（`/web/file-events` 订阅端点的服务级连接上限，默认 200）由
 * `src/server/routes/web/file-events.ts` 在超限时 close 1013。两条 schema 与默认值逐字照抄宿主
 * `apps/server/src/env.ts` 的原行，本包既不读 `process.env` 也不做第二份归一；route A 下
 * `envDefinitions` 只承担启动期校验与汇总，值仍由宿主 `bootstrap/module-configs.ts` 投影进模块配置，
 * 本包继续经 `getMachineConfig()` 读取。两键都是启动期快照（改后需重启），故 `restartRequired: true`。
 *
 * 有意**不**声明三个同族旋钮（`RCS_FILE_WS_IDLE_TIMEOUT_MS` / `RCS_FILE_WS_SWEEP_INTERVAL_MS` /
 * `RCS_FILE_WS_SWEEP_ENABLED`）：它们的真实消费者是宿主启动序（`apps/server/src/config.ts` →
 * `bootstrap/host-startup.ts` 的 `startFileWsSweep`），本包只在注释里提到，并非机器域配置，归属宿主。
 *
 * 不声明 `web`：消费方是 §1.6 的 WebShell 装配，形状必须与消费端同时定型。
 */
export const moduleManifest = {
  id: "machine",
  kind: "resource",
  dependsOn: ["agent-config"],
  capabilities: ["resource.machine"],
  envDefinitions: [
    {
      moduleId: "machine",
      key: "RCS_FILE_WS_IDENTITY_STRICT",
      // 与宿主 env.ts:125-128 逐字等价：先补默认字符串再归一为布尔，空串/未设置都落在宽松 false。
      schema: z
        .string()
        .default("false")
        .transform((v) => v === "true"),
      defaultValue: "false",
      secret: false,
      restartRequired: true,
      description:
        "file-ws register 的身份绑定严格模式（§7.1）：未知 machine 的注册帧是否按 close(4404) 拒绝。默认 false（宽松放行 + 告警）；两阶段过渡软开关，须机器端先行升级后再开启。由本模块在 register 处理时读取。",
    },
    {
      moduleId: "machine",
      key: "RCS_FILE_EVENTS_MAX_CLIENTS",
      // 与宿主 env.ts:132 逐字等价：字符串数字（含空串归一）中的正整数，超限关闭码由路由侧决定。
      schema: z.coerce.number().int().positive().default(200),
      defaultValue: 200,
      secret: false,
      restartRequired: true,
      description:
        "/web/file-events 文件变更事件订阅端点的服务级并发连接上限，与 YJS_MAX_CLIENTS 分池互不挤占。默认 200，超限 close 1013。由本模块在 WS 升级时读取。",
    },
  ],
  contributions: [
    {
      id: "machine.web-fs",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createMachineWebFsRoutes(host)),
    },
    {
      id: "machine.web-file-events",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createMachineWebFileEventsRoutes(host)),
    },
    {
      id: "machine.web-registry",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createMachineWebRegistryRoutes(host)),
    },
    {
      id: "machine.api-workspaces",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createMachineApiWorkspaceRoutes(host)),
    },
  ],
  create: () => import("./src/module").then((module) => module.createMachineModule()),
} satisfies ModuleManifest;
