/** ChatArea 的独立浏览器入口，保留其样式副作用与原有加载顺序。 */
export { ChatArea } from "./src/pages/agent-panel/ChatArea";
export {
  evictDeletedEnvironmentSlots,
  resolveActiveChatEnvironmentId,
} from "./src/pages/agent-panel/chat-area-lifecycle";
