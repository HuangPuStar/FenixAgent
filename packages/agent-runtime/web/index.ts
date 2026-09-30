/**
 * `@fenix/agent-runtime/web` —— 本包的聊天面板浏览器面出口。
 *
 * 与包根入口 `src/index.ts`（Environment / Chat 状态 hook / YJS 的浏览器安全出口，供 workflow、task 等
 * 跨包消费者使用）分工：本出口只导出**聊天面板实现**，即台账 `ce-standards-todo.md` D1 归位本包的
 * chat 域实现。两者不相互重导出——根入口若带上面板，任何只需要 Y.Doc 绑定的消费者都会被动加载整棵
 * React 面板图（ui-components 的 chat 外壳、ACPMain）。
 *
 * 出口粒度按消费方的加载时机切分，不是「有实现就进桶」：
 * - `ChatPanel`（本文件导出）：宿主壳**懒加载**它（`React.lazy`），桶出口正好落在懒加载边界上；
 * - `chat-area-lifecycle` 的纯策略函数：宿主壳**同步**消费，进桶会把整块面板拖进首屏 chunk，
 *   故走窄子路径 `@fenix/agent-runtime/web/agent-panel/chat-area-lifecycle`（同 `@fenix/identity`
 *   的 `web/pages/login/LoginPage` 口径）。
 */

export { ChatPanel, type ChatPanelProps } from "./agent-panel/ChatPanel";
export type {
  ChatPanelHostPorts,
  PeriTaskDetailLoader,
  PeriTaskViewsResult,
  UsePeriTaskViews,
} from "./agent-panel/chat-panel-host-ports";
