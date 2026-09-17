/**
 * 控制台浏览器 UI 入口。
 *
 * 此入口只组合 React 组件与浏览器安全的 `@fenix/chat-channel` 根入口；服务端
 * 控制面、持久化和 DocManager 必须继续从 `@fenix/chat-channel/server` 导入。
 */
export { ACPMain } from "./components/ACPMain";
export { ChatInterface, type ChatInterfaceHandle } from "./components/ChatInterface";
export { ContextPanel } from "./components/ContextPanel";
