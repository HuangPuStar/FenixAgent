/**
 * chat —— Chat UI 体系分组出口。
 *
 * 逐模块 `export *`，覆盖 `web/chat/` 下全部对外模块：primitives（原 `ai-elements` 组）、lib 纯函数、
 * narrators 注册表、view / timeline / composer / panels / shell 五个组件层，另有 `./types` 的类型出口，
 * 使「只导入本 barrel」的消费方也能拿到结构类型。各层自己的 `internal/` 子目录（如 `shell/internal/`、
 * `primitives/internal/`、`view/internal/`、`composer/internal/`）与 type 契约的实现文件 `chat/internal/`
 * 都是实现细节，不在此导出。
 *
 * 唯一的显式排除：`primitives/permission-request` 的组件层 `PermissionOption` 与 `./types` 内联的协议
 * 同名类型冲突（结构兼容、声明独立），权威类型由 `./types` 提供，需要组件层声明的消费方深链该模块。
 *
 * 末尾的 `import "./css/chat.css"` 是刻意的副作用导入：chat 设计层样式（会话外壳、消息视图、
 * 工具时间线、状态面板、输入岛、命令面板、划词浮层、窄屏适配）在包内没有唯一宿主组件，
 * 由本聚合入口负责加载，保证「消费方导入本 barrel 即得完整视觉」。
 * 组件自导入的样式（`primitives/conversation.css`、`primitives/chat-message-content.css`、
 * `css/chat-navigation-aids.css`）不在此重复导入。
 *
 * 维护约定：新增或删除 `web/chat/` 下的模块时必须同步本文件与根 `web/index.ts`，
 * 否则深链与整包导入会出现能力差异。
 */

// composer —— 输入岛层
export * from "./composer/ChatComposer";
export * from "./composer/CommandMenu";
export * from "./composer/chat-image-content";
export * from "./composer/composer-assets";
export * from "./composer/composer-context-meter";
export * from "./composer/composer-effects";
export * from "./composer/composer-file-processing";
export * from "./composer/composer-handlers";
export * from "./composer/composer-prompt";
export * from "./composer/composer-state";
export * from "./composer/composer-toolbar";
export * from "./composer/SessionModeSelector";
export * from "./composer/useDragUpload";
// lib —— 纯函数与派生逻辑
export * from "./lib/chat-derived-state";
export * from "./lib/chat-render-layout";
export * from "./lib/context-queue";
export * from "./lib/extract-changed-files";
export * from "./lib/session-actions";
export * from "./lib/session-grouping";
export * from "./lib/simplify-model-display-name";
export * from "./lib/strip-html-tags";
export * from "./lib/token-stats";
export * from "./lib/tool-call-utils";
export * from "./lib/tool-semantic";
// narrators —— 工具叙述注册表（其余 narrator 模块由注册表内部消费）
export * from "./narrators/index";
// panels —— 面板层
export * from "./panels/chat-status-panel";
export * from "./panels/PermissionPanel";
export * from "./panels/QuestionPanel";
// primitives —— 对话与产物展示基元（含 prompt-input 子体系）
export * from "./primitives/code-block";
export * from "./primitives/conversation";
export * from "./primitives/iframe-preview";
export * from "./primitives/message";
export * from "./primitives/message-attachments";
// 权限按钮的组件层同构 `PermissionOption` 与 `./types` 内联的协议同名类型冲突（两者结构兼容，
// 但声明独立）。本 barrel 显式排除组件层声明，权威类型由 `./types` 提供；需要组件层声明的
// 消费方可深链 `@fenix/ui-components/chat/primitives/permission-request`。
export type { ToolPermissionButtonsProps } from "./primitives/permission-request";
export { ToolPermissionButtons } from "./primitives/permission-request";
export * from "./primitives/prompt-input";
export * from "./primitives/reasoning";
export * from "./primitives/shimmer";
export * from "./primitives/tool";
// shell —— 会话外壳层
export * from "./shell/ACPMain";
export * from "./shell/AgentAvatar";
export * from "./shell/AgentBadge";
export * from "./shell/ChatHeader";
export * from "./shell/ChatInterface";
export * from "./shell/chat-interface-types";
export * from "./shell/FilePickerPanel";
export * from "./shell/sidebar-session-list";
// timeline —— 工具时间线层
export * from "./timeline/HindsightToolCard";
export * from "./timeline/SubAgentPanel";
export * from "./timeline/sub-agent-tool-call-context";
export * from "./timeline/TodoChanges";
export * from "./timeline/ToolCallGroup";
export * from "./timeline/ToolCallRow";
// types —— 结构类型契约（phase1 产出的唯一类型导入面）
export type * from "./types";
// view —— 消息视图层
export * from "./view/ChatQuoteMessage";
export * from "./view/ChatView";
export * from "./view/CitationLink";
export * from "./view/chat-navigation-aids";
export * from "./view/MessageBubble";
export * from "./view/SystemMessage";
// 设计层样式：作为分组 barrel 的副作用依赖加载，见文件头说明。
import "./css/chat.css";
