import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * Sandbox 资源模块描述符。
 *
 * 沙盒资源池、沙盒实例生命周期与远程 Sandbox Cluster 管理协议的唯一 owner。装配面上的消费者是
 * 宿主 `apps/server`（装配期注册 provider、初始化默认池、挂载 `/web/config/sandbox-pools` 与
 * `/api/system/sandbox-*`）与 `@fenix/agent-runtime`（按 pool 解析可执行实例）。
 *
 * `dependsOn` 暂为空：本模块生产代码静态导入 `@fenix/resource-machine/server` 的公开入口（创建沙盒机器、
 * 机器在线判定、释放机器 runtime、机器归属查询），但 machine 尚未注册为模块，此刻声明会让 registry
 * 生成器以"引用了未注册模块"失败。machine 的 manifest 落地时必须补成 `dependsOn: ["machine"]`，本包
 * `package.json` 已声明 `@fenix/resource-machine` 的 workspace 依赖，补齐时无需改依赖清单。
 *
 * 「必须补」不是靠这段注释生效的：生成器的装配依赖反向校验（`assertDependsOnComplete`）会在 machine
 * 注册的那一刻起拒绝留空——只要本包 `src/**` 静态导入了某个已注册资源模块，就要求它出现在 `dependsOn`。
 * 方向 sandbox → machine 也是 §2.3 依赖矩阵固定的方向，machine 侧的既有反向边（machine → sandbox）
 * 已由架构台账登记为越界边（owner 1.4），因此这里声明不会与它构成装配循环。
 *
 * 不声明 `contributions` 与 `web`：两者的消费方分别是 §1.5 的宿主挂载与 §1.6 的 WebShell 装配，
 * 形状必须与消费端同时定型；单方面发明会返工。当前宿主按显式调用装配（路由工厂注入守卫），
 * 与「先声明后接线」的中间态相比不会留下第二套装配路径。
 */
export const moduleManifest = {
  id: "sandbox",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.sandbox"],
  // 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Drizzle、Elysia 与 provider SDK 拖进模块图。
  create: () => import("./src/module").then((module) => module.createSandboxModule()),
} satisfies ModuleManifest;
