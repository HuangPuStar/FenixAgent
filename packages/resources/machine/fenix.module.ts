import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";

/**
 * Machine 资源模块描述符。
 *
 * 远程机器（RCS machine）的注册与心跳、Agent 进程路由、file-ws 传输与 workspace 文件域的唯一 owner。
 * 装配面上的消费者是宿主 `apps/server`（注册 machine 路由与 file-ws 接入、启动心跳清扫）与
 * `@fenix/resource-sandbox`（执行请求等待机器回连后寻址）。
 *
 * `dependsOn: ["agent-config"]`：本包 `src/server/services/remote-file-service.ts` 经
 * `@fenix/agent-config/server` 读取 Agent 配置并解析 AgentNode。这是本包唯一的包间**运行时**依赖。
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
 * 不声明 `web`：消费方是 §1.6 的 WebShell 装配，形状必须与消费端同时定型。
 */
export const moduleManifest = {
  id: "machine",
  kind: "resource",
  dependsOn: ["agent-config"],
  capabilities: ["resource.machine"],
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
  ],
  create: () => import("./src/module").then((module) => module.createMachineModule()),
} satisfies ModuleManifest;
