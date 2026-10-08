import type { ModuleFactoryContext } from "@fenix/platform-sdk";
import { createWorkflowV2ServerModule, type WorkflowV2ServerModule } from "./server/module";

/**
 * Workflow V2 模块的 registry 装配入口（`fenix.module.ts` 的 `create` 目标）。
 *
 * 转发 `context` 的原因只有一条：对账任务（4A）是周期任务，要经 `context.registerCleanup` 接上「装配失败
 * 与应用关闭时按逆序清理」这条生命周期（见 `./server/module`）。除清理登记外，本模块仍不消费任何跨包端口
 * ——manifest 的 `dependsOn: []` 声明它是不依赖 access-control 注入面的叶子模块。
 *
 * 真正的构造在 `./server/module`：本文件只把 registry 的加载时机与包内实现分开——registry 会被大量位置
 * 导入，不能在这一层就把 Elysia / Drizzle 拖进模块图。
 */
export function createWorkflowV2Module(context: ModuleFactoryContext): WorkflowV2ServerModule {
  return createWorkflowV2ServerModule(context);
}
