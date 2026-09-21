import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";

/**
 * Sandbox 资源模块描述符。
 *
 * 沙盒资源池、沙盒实例生命周期与远程 Sandbox Cluster 管理协议的唯一 owner。装配面上的消费者是
 * 宿主 `apps/server`（装配期注册 provider、初始化默认池、挂载 `/web/config/sandbox-pools` 与
 * `/api/system/sandbox-*`）与 `@fenix/agent-runtime`（按 pool 解析可执行实例）。
 *
 * `dependsOn: ["machine"]`：本模块生产代码静态导入 `@fenix/resource-machine/server` 的公开入口（创建沙盒
 * 机器、机器在线判定、释放机器 runtime、机器归属查询），两者必须成套启用，方向与 §2.3 依赖矩阵一致。
 * machine 侧的既有反向边（machine → sandbox）已由架构台账登记为 `special-dependency`（owner 1.4，须
 * 消除），因此它不声明本模块，声明也不会构成装配循环；生成器的装配依赖反向校验（`assertDependsOnComplete`）
 * 会持续守着这一点。
 *
 * 声明 `contributions`（1.5e）：`/web/config/sandbox-pools` 的路由实例由本模块以惰性构造函数
 * `(host) => import("./src/server/assembly").then(...)` 给出，`slot: "web-config"` 指明挂宿主 `/web/config`
 * 聚合面——路由路径是相对形式，前缀由宿主的聚合实例决定，「挂哪一面」只能由声明说清。惰性 import 与
 * `create` 同因：registry 会被大量位置导入，不能在索引层就把 Elysia 拖进模块图。
 * `/api/system/sandbox-*` 仍由宿主按显式调用装配：系统 API 面尚未接入贡献槽，声明一个没有读者的贡献只会
 * 让装配在未知槽上失败。
 *
 * 不声明 `web`：消费方是 §1.6 的 WebShell 装配，形状必须与消费端同时定型。
 */
export const moduleManifest = {
  id: "sandbox",
  kind: "resource",
  dependsOn: ["machine"],
  capabilities: ["resource.sandbox"],
  contributions: [
    {
      id: "sandbox.web-config",
      kind: "app-route",
      slot: "web-config",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createSandboxWebConfigRoutes(host)),
    },
  ],
  // 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Drizzle、Elysia 与 provider SDK 拖进模块图。
  create: () => import("./src/module").then((module) => module.createSandboxModule()),
} satisfies ModuleManifest;
