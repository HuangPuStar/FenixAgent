// web/pages/workflow/workflow-path.ts
// 工作流页面的视图解析（纯函数，无 React / Router / 宿主依赖）。
//
// **为什么单独成文件**：解析逻辑原先内联在 `pages/WorkflowPage.tsx` 里，直接从 `window.location` 读地址。
// 改成「视图从 Router 派生」之后，这段解析是当时唯一的视图状态来源，必须能被单独测到；而整页组件的值
// 导入图会经 `WorkflowEditor → @fenix/agent-runtime → @fenix/chat-channel` 一路穿到别的包（`web/index.ts`
// 的说明与 `workflow-browser-surface.test.ts` 的守卫都记录了这件事），测试从页面入口导入会连带加载那整条
// 链。把纯逻辑拆出来后，用例只依赖本文件（`web/__tests__/workflow-page-route.test.ts`）。
//
// **当前状态（2026-09-22，整页实现归宿主的裁定落地后）**：整页实现由宿主三份路由壳持有
// （`apps/web/src/routes/agent/_panel/workflow*.tsx`），包内整页副本已删除，本模块因此不再有生产消费方，
// 只剩上面那个守卫用例在跑它。保留还是随页面一并退役（连用例一并处置）由 owner 裁定：本轮只随删除同步
// 记下事实，行为与导出面未动。

/**
 * 工作流视图。
 *
 * `list` / `runs` 是页面内的 tab，`edit` / `versions` 是独立子视图（编辑该工作流 / 版本历史）。
 */
export type WfView = "list" | "edit" | "versions" | "runs";

export interface WfRoute {
  view: WfView;
  workflowId?: string;
  runId?: string;
}

/**
 * 工作流视图基址。
 *
 * 现行控制台的工作流路径由宿主三份路由文件注册（`apps/web/src/routes/agent/_panel/workflow.tsx`、
 * `workflow_.$id.edit.tsx`、`workflow_.$id.versions.tsx`）。页面原先自持 `/ctrl/workflow/*` 子路由并用
 * `window.history.pushState` 改写地址栏，`/ctrl` 是旧控制台前缀；前端规范把 location 写操作列为 P0 禁令，
 * 跳转必须回到 TanStack Router，而 Router 只认**已注册**的路由 ID（未注册路径在 `navigate()` 时直接抛错），
 * 所以视图解析与跳转必须与实际路由同处一个路径空间。同包 `WorkflowVersions` 的
 * `<Link to="/agent/workflow/$id/edit">` 已经在这个路径空间里。
 */
export const WORKFLOW_LIST_PATH = "/agent/workflow";

/**
 * 从 Router 的 pathname 解析视图。
 *
 * 只认 `workflow` 段之后的形状：`/agent/workflow` → 列表、`/agent/workflow/runs` → 运行记录、
 * `/agent/workflow/:id/edit|versions` → 子视图。未命中工作流子路径时回落列表页——本页可能被挂在
 * `/agent/*` 的任意一层，拿到别的路径时给出可用的默认视图比渲染空白更安全。
 */
export function parseWorkflowPath(pathname: string): WfRoute {
  const segments = pathname.split("/").filter(Boolean);
  const base = segments.indexOf("workflow");
  if (base === -1) return { view: "list" };

  const section = segments[base + 1];
  const sub = segments[base + 2];
  if (section === "runs") return { view: "runs" };
  if (section && sub === "edit") return { view: "edit", workflowId: section };
  if (section && sub === "versions") return { view: "versions", workflowId: section };
  return { view: "list" };
}
