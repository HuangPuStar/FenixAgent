/**
 * chat/primitives 分组出口：对话与产物展示基元（原 `ai-elements` 组，2026-09-18 随 Chat UI 体系收编改名为 `chat/primitives`）。
 *
 * 与源 `apps/web/components/ai-elements/index.ts`（旧路径，已于 2026-09-21 由 5c6aa9089 删除） 的差异：补上了源文件漏导出、但被 `message.tsx`
 * 使用的 `iframe-preview` 与 `message-attachments`（源实现只能通过深链引用这两个模块）。
 * 消费方若需要整包出口，应使用根 barrel；本文件只是同组便捷入口。
 */
export * from "./code-block";
export * from "./conversation";
export * from "./iframe-preview";
export * from "./message";
export * from "./message-attachments";
export * from "./permission-request";
export * from "./prompt-input";
export * from "./reasoning";
export * from "./shimmer";
export * from "./tool";
