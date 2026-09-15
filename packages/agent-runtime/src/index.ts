/**
 * 浏览器安全入口；只导出 Environment、Chat 与 YJS 的浏览器侧实现。
 * 服务端 runtime 实现必须经 `@fenix/agent-runtime/server` 使用，避免进入 Vite bundle。
 */

export { ChatPanel } from "../web/agent-panel/ChatPanel";
export * from "../web/api/environments";
export * from "../web/hooks/use-chat-state";
export * from "../web/hooks/use-session-state";
export * from "../web/yjs/doc-hub";
export * from "../web/yjs/yjs-ws";
