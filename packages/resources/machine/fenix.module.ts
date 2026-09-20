import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * Machine 资源模块描述符。
 *
 * 远程机器（RCS machine）的注册与心跳、Agent 进程路由、file-ws 传输与 workspace 文件域的唯一 owner。
 * 装配面上的消费者是宿主 `apps/server`（注册 machine 路由与 file-ws 接入、启动心跳清扫）与
 * `@fenix/resource-sandbox`（执行请求等待机器回连后寻址）。
 *
 * `dependsOn: ["agent-config"]`：本包 `src/server/services/remote-file-service.ts` 经
 * `@fenix/agent-config/server` 读取 Agent 配置并解析 AgentNode。反向的 `machine → sandbox` 边（同一个
 * 文件里查询沙盒实例判定文件是否可读）已由架构台账登记为 `special-dependency`（owner 1.4，方向固定为
 * sandbox → machine，须消除），因此**不得**写进 `dependsOn`：两者同时启用时装配顺序会成环，生成器的
 * 装配依赖反向校验也会拒绝这种编码。
 *
 * `create`：惰性组合根（`src/module.ts` 的 `createMachineModule()`），模块索引层只 import 本文件，装配期
 * 再按需加载 `./server` 图——file-ws 连接索引、心跳巡检与事件队列都是进程级单例，装配只能从这一处进入。
 *
 * 不声明 `contributions` 与 `web`：消费方分别是 §1.5 的宿主挂载与 §1.6 的 WebShell 装配，形状必须与
 * 消费端同时定型；当前宿主按显式调用装配，不形成第二套装配路径。
 */
export const moduleManifest = {
  id: "machine",
  kind: "resource",
  dependsOn: ["agent-config"],
  capabilities: ["resource.machine"],
  create: () => import("./src/module").then((module) => module.createMachineModule()),
} satisfies ModuleManifest;
