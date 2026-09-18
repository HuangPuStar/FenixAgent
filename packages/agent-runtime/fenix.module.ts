import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * Agent Runtime 的静态装配描述符。
 *
 * `dependsOn` 为空：Runtime 只允许依赖 platform-sdk、四个基础运行包以及 Machine/Sandbox 的
 * 专用公开运行入口，不依赖 AccessControl、Identity 或任何资源模块。Runtime 接受的是已经
 * 授权的通用启动输入，不解释 actor/role/visibility。
 *
 * 工厂按需加载服务端运行组合面，使生成的 registry 保持为轻量 manifest 索引，不把 Elysia、
 * Drizzle 与 relay 全量拖进任何导入 registry 的位置。
 *
 * 已知不足：当前返回的是 Runtime 服务端公开入口的整体表面，而不是收敛后的启动/停止/状态/
 * 回收 port。任务 1.4 定义 Runtime port 时必须替换本工厂；此处不使用占位实现，以免形成
 * 第二套运行入口。
 */
export const moduleManifest = {
  id: "agent-runtime",
  kind: "agent-runtime",
  dependsOn: [],
  capabilities: ["runtime.agent"],
  create: () => import("./src/server"),
} satisfies ModuleManifest;
