/**
 * 浏览器安全入口；只导出 Environment、Chat 与 YJS 的浏览器侧实现。
 * 服务端 runtime 实现必须经 `@fenix/agent-runtime/server` 使用，避免进入 Vite bundle。
 *
 * `ChatPanel` 曾在此导出（workflow 包的 `MetaAgentPanel` 消费）。CE 阶段 2 §1.6 T6d 起它是宿主
 * 接线层（依赖 identity 的 web 与宿主的 hooks/i18n），物理迁入 `apps/web/src/pages/agent-panel/`，
 * 改由宿主经 `WorkflowEditor` 的 `chatPanel` 端口注入，故不再经包出口对外。
 */

export * from "../web/api/environments";
export * from "../web/hooks/use-chat-state";
export * from "../web/hooks/use-session-state";
export * from "../web/yjs/doc-hub";
export * from "../web/yjs/yjs-ws";
