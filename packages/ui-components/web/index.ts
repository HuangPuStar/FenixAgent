/**
 * @fenix/ui-components 公共出口。
 *
 * 逐模块 `export *`，便于消费方按需深链（`@fenix/ui-components/ui/button`）而不必经过整包 barrel。
 * 组件源码全部位于 `web/` 下：宿主 Tailwind 只扫描各包源码所在的 web 目录，脱离该约定会导致
 * 包内工具类被裁剪。
 *
 * 出口覆盖 `web/` 下全部对外模块；各分组的 `internal/` 子目录与分组自身的 `index.ts` 子 barrel
 * 不属于公共面，前者是实现细节，后者只是同组别名。新增或删除模块时必须同步本文件，否则深链与整包导入会出现能力差异。
 */

// chat —— Chat UI 体系（lib 纯函数 + narrators 叙述表 + view / timeline / composer / panels / shell 组件层；
// primitives 为原 ai-elements 组，2026-09-18 改名迁入）
export * from "./chat/composer/ChatComposer";
export * from "./chat/composer/CommandMenu";
export * from "./chat/composer/chat-image-content";
export * from "./chat/composer/composer-assets";
export * from "./chat/composer/composer-context-meter";
export * from "./chat/composer/composer-effects";
export * from "./chat/composer/composer-file-processing";
export * from "./chat/composer/composer-handlers";
export * from "./chat/composer/composer-prompt";
export * from "./chat/composer/composer-state";
export * from "./chat/composer/composer-toolbar";
export * from "./chat/composer/SessionModeSelector";
export * from "./chat/composer/useDragUpload";
export * from "./chat/lib/chat-derived-state";
export * from "./chat/lib/chat-render-layout";
export * from "./chat/lib/context-queue";
export * from "./chat/lib/extract-changed-files";
export * from "./chat/lib/session-actions";
export * from "./chat/lib/session-grouping";
export * from "./chat/lib/simplify-model-display-name";
export * from "./chat/lib/strip-html-tags";
export * from "./chat/lib/token-stats";
export * from "./chat/lib/tool-call-utils";
export * from "./chat/lib/tool-semantic";
export * from "./chat/narrators/index";
export * from "./chat/panels/chat-status-panel";
export * from "./chat/panels/PermissionPanel";
export * from "./chat/panels/QuestionPanel";
export * from "./chat/primitives/code-block";
export * from "./chat/primitives/conversation";
export * from "./chat/primitives/iframe-preview";
export * from "./chat/primitives/message";
export * from "./chat/primitives/message-attachments";
export type { ToolPermissionButtonsProps } from "./chat/primitives/permission-request";
// 权限按钮的组件层同构 `PermissionOption` 与 `./chat/types` 内联的协议同名类型冲突（两者结构兼容，
// 但声明独立）。根 barrel 显式排除组件层声明，权威类型由 `./chat/types` 提供；需要组件层声明的
// 消费方可深链 `@fenix/ui-components/chat/primitives/permission-request`。
export { ToolPermissionButtons } from "./chat/primitives/permission-request";
export * from "./chat/primitives/prompt-input";
export * from "./chat/primitives/reasoning";
export * from "./chat/primitives/shimmer";
export * from "./chat/primitives/tool";
export * from "./chat/shell/ACPMain";
export * from "./chat/shell/AgentAvatar";
export * from "./chat/shell/AgentBadge";
export * from "./chat/shell/ChatHeader";
export * from "./chat/shell/ChatInterface";
export * from "./chat/shell/ContextPanel";
export * from "./chat/shell/chat-interface-types";
export * from "./chat/shell/FilePickerPanel";
export * from "./chat/shell/sidebar-session-list";
export * from "./chat/timeline/HindsightToolCard";
export * from "./chat/timeline/SubAgentPanel";
export * from "./chat/timeline/sub-agent-tool-call-context";
export * from "./chat/timeline/TodoChanges";
export * from "./chat/timeline/ToolCallGroup";
export * from "./chat/timeline/ToolCallRow";
export type * from "./chat/types";
export * from "./chat/view/ChatQuoteMessage";
export * from "./chat/view/ChatView";
export * from "./chat/view/CitationLink";
export * from "./chat/view/chat-navigation-aids";
export * from "./chat/view/MessageBubble";
export * from "./chat/view/SystemMessage";
// chat 设计层样式在包内没有唯一宿主组件（见 `web/chat/index.ts` 文件头），由根 barrel 一并加载，
// 保证「导入 @fenix/ui-components 即得完整 chat 视觉」；组件自导入的样式不在此重复导入。
import "./chat/css/chat.css";

// components —— 复合组件
export * from "./components/AgentCardList";
export * from "./components/agent-master-detail-workspace";
export * from "./components/file-icon-helper";
export * from "./components/file-tree-arborist";
export * from "./components/file-tree-context-menu";
export * from "./components/file-tree-input-dialog";
export * from "./components/file-tree-model";
export * from "./components/file-tree-view";
export * from "./components/PreviewTab";
export * from "./components/preview/FileViewerPreview";
export * from "./components/preview/html-plugin";
export * from "./components/preview/native-pdf-plugin";
export * from "./components/preview/preview-source";
export * from "./components/WorkbenchPanel";
// config —— 配置型业务无关容器
export * from "./config/BatchActionBar";
export * from "./config/ConfirmDialog";
export * from "./config/DataTable";
export * from "./config/EmptyState";
export * from "./config/FormDialog";
export * from "./config/StatusBadge";
// layout —— 页面骨架
export * from "./layout/app-header";
export * from "./layout/app-page";
// lib —— 包内基础设施
export * from "./lib/card-renderer";
export * from "./lib/cn";
export * from "./lib/i18n";
export * from "./lib/theme";
// ui —— 基础控件
export * from "./ui/accordion";
export * from "./ui/alert-dialog";
export * from "./ui/badge";
export * from "./ui/button";
export * from "./ui/button-group";
export * from "./ui/calendar";
export * from "./ui/card";
export * from "./ui/chart";
export * from "./ui/checkbox";
export * from "./ui/collapsible";
export * from "./ui/command";
export * from "./ui/connection-status";
export * from "./ui/date-picker";
export * from "./ui/dialog";
export * from "./ui/dialog-xl";
export * from "./ui/dropdown-menu";
export * from "./ui/form";
export * from "./ui/hover-card";
export * from "./ui/input";
export * from "./ui/input-group";
export * from "./ui/label";
export * from "./ui/pagination";
export * from "./ui/popover";
export * from "./ui/progress";
export * from "./ui/resizable";
export * from "./ui/scroll-area";
export * from "./ui/select";
export * from "./ui/separator";
export * from "./ui/sheet";
export * from "./ui/skeleton";
export * from "./ui/slider";
export * from "./ui/switch";
export * from "./ui/table";
export * from "./ui/tabs";
export * from "./ui/textarea";
export * from "./ui/theme-toggle";
export * from "./ui/tooltip";
export * from "./ui/tree";
export * from "./ui/use-roving-list-navigation";
