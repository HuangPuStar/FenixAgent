import type { ModuleManifest } from "@fenix/platform-sdk";

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
 * 不声明 `contributions` 与 `web`：两者的消费方分别是 §1.5 的宿主挂载与 §1.6 的 WebShell 装配，
 * 形状必须与消费端同时定型；单方面发明会返工。当前宿主按显式调用装配（路由工厂注入守卫），
 * 与「先声明后接线」的中间态相比不会留下第二套装配路径。
 */
export const moduleManifest = {
  id: "sandbox",
  kind: "resource",
  dependsOn: ["machine"],
  capabilities: ["resource.sandbox"],
  // 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Drizzle、Elysia 与 provider SDK 拖进模块图。
  create: () => import("./src/module").then((module) => module.createSandboxModule()),
} satisfies ModuleManifest;
