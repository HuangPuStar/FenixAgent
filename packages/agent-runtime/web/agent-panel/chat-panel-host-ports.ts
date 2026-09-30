/**
 * `ChatPanel` 的宿主能力端口——本包不得依赖、只能由宿主解析后注入的四项能力（登录态、Peri Task 订阅、
 * Peri Task 详情取数、已绑定 MCP）。
 *
 * 为什么需要这层端口（`.dependency-cruiser.cjs` 与 `scripts/lib/architecture-boundary-rules.ts`
 * 的可执行边界）：
 * - `authState`：登录态由 `@fenix/identity/web` 的 `useSession` 提供，而 identity 是 platform-impl，
 *   agent-runtime 不得依赖（矩阵 `agent-runtime → platform-impl` 禁则）。宿主用
 *   `resolveChatAuthState()`（本包 `web/hooks/chat-auth-state.ts` 的纯函数，宿主可经包出口取用）解析后注入
 *   三态结果，包内只按三态分支渲染与守卫建连。
 * - `usePeriTaskViews`：Peri Task 投影的 owner 是 `@fenix/resource-task`（`web/hooks/use-task-views.ts`），
 *   agent-runtime 不得依赖资源包（`.dependency-cruiser.cjs` 的 `agent-runtime-not-to-resources`）。该投影
 *   绑定的是**本包**持有的 Y.Doc（`DocHub` 共享实例 + 按 `rcsSessionId` 派生的 doc key），因此这里注入的
 *   是**订阅能力**而不是订阅结果：`rcsSessionId` 的派生规则只在本包 `use-chat-panel-runtime.ts` 内存在一份，
 *   宿主按槽位取数会让同一规则出现第二份实现（键一旦漂移，面板读到的就是别人的会话数据）。
 * - `loadPeriTaskDetail`：详情取数的 owner 是 `@fenix/model-management`（与后端 route 同包），同样不得由
 *   本包依赖，与 `@fenix/ui-components` 的 `PeriTaskDetailSheet`（只收注入的 `loadDetail`）口径一致。
 * - `boundMcps`：取数要同时读 agent-config 与 MCP 资源包，由宿主取好注入；未注入时命令菜单只显示 ACP
 *   命令、不含 MCP 条目（面板仍可用）。
 *
 * 注入点唯一：宿主壳 `apps/web/src/pages/agent-panel/ChatArea.tsx` 组装一次，经 `hostPorts` 透传给每个
 * keep-alive 槽位的 `ChatPanel`。
 */

import type { PeriTaskViewProjection } from "@fenix/chat-channel";
import type { PeriTaskDetailSheetProps } from "@fenix/ui-components/chat/panels/PeriTaskDetailSheet";
import type { BoundMcpOption } from "@fenix/ui-components/chat/shell/chat-interface-types";
import type { ChatAuthState } from "../hooks/chat-auth-state";

/** `usePeriTaskViews` 的返回结构（与 `@fenix/resource-task` 的 `useTaskViews` 返回逐字段一致）。 */
export interface PeriTaskViewsResult {
  state: {
    /** 已排序的任务视图；Session Doc 子树未变时引用稳定。 */
    tasks: readonly PeriTaskViewProjection[];
    /** Session Doc 的 tasks/taskOrder 子树是否已同步（未同步时面板展示加载态）。 */
    loaded: boolean;
  };
}

/**
 * Peri Task 视图订阅的宿主实现（即 `@fenix/resource-task/web/hooks/use-task-views`）。
 *
 * 这是一个 **hook**：包内只在 `useChatPanelRuntime` 顶层按本包派生的 `docHubKey` 调用一次，宿主必须传
 * 稳定引用（模块级导入，不要包内联箭头函数），否则每次渲染都会重订阅。声明成「返回结构」而不是值，
 * 是为了让宿主可以直接把 owner 的 hook 传进来，不必在两侧各写一个形状转换的适配层。
 */
export type UsePeriTaskViews = (docHubKey: string) => PeriTaskViewsResult;

/** Peri Task 详情取数的宿主实现（`@fenix/model-management/web` 的 `getPeriTaskDetail`）。 */
export type PeriTaskDetailLoader = PeriTaskDetailSheetProps["loadDetail"];

/** 宿主注入 `ChatPanel` 的能力集合；除 `loadPeriTaskDetail`、`boundMcps` 外均为必需项。 */
export interface ChatPanelHostPorts {
  /** 宿主解析好的登录态三态（见 `../hooks/chat-auth-state.ts`）。 */
  authState: ChatAuthState;
  /** 已登录用户 id；`authState === "ready"` 时必有值（与 `authState` 同一次 `useSession()` 的结果）。 */
  userId: string | undefined;
  /** Peri Task 视图订阅能力（见本文件头部说明）。 */
  usePeriTaskViews: UsePeriTaskViews;
  /** Peri Task 详情取数；未注入时任务行只读，不打开详情抽屉。 */
  loadPeriTaskDetail?: PeriTaskDetailLoader;
  /** 已绑定 MCP 列表；未注入时命令菜单不含 MCP 条目。 */
  boundMcps?: readonly BoundMcpOption[];
}
