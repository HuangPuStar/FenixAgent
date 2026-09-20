import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * Agent Runtime 的静态装配描述符。
 *
 * `dependsOn` 为空：Runtime 只允许依赖 platform-sdk、四个基础运行包以及 Machine/Sandbox 的
 * 专用公开运行入口，不依赖 AccessControl、Identity 或任何资源模块。Runtime 接受的是已经
 * 授权的通用启动输入，不解释 actor/role/visibility。
 *
 * 工厂按需加载运行组合根（`src/runtime.ts`），使生成的 registry 保持为轻量 manifest 索引，
 * 不把 Elysia、Drizzle 与 relay 全量拖进任何导入 registry 的位置。
 *
 * `create` 返回收敛后的运行 port（`AgentRuntimeModule.runtime`），不是服务端公开入口的整体
 * 表面（1.4 W3 前的临时形态）：端口的目标是让 registry 驱动的装配能拿到唯一的实例/环境
 * 生命周期入口，而宿主装配面（`./server` 的注入 port、路由工厂）由宿主显式调用。
 */
export const moduleManifest = {
  id: "agent-runtime",
  kind: "agent-runtime",
  dependsOn: [],
  capabilities: ["runtime.agent"],
  create: () => import("./src/runtime").then((module) => module.createAgentRuntimeModule()),
} satisfies ModuleManifest;
