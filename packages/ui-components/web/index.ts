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

// ai-elements —— 对话与产物展示元件
export * from "./ai-elements/code-block";
export * from "./ai-elements/conversation";
export * from "./ai-elements/iframe-preview";
export * from "./ai-elements/message";
export * from "./ai-elements/message-attachments";
export * from "./ai-elements/permission-request";
export * from "./ai-elements/prompt-input";
export * from "./ai-elements/reasoning";
export * from "./ai-elements/shimmer";
export * from "./ai-elements/tool";
// components —— 复合组件
export * from "./components/AgentCardList";
export * from "./components/agent-master-detail-workspace";
export * from "./components/file-icon-helper";
export * from "./components/file-tree-input-dialog";
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
