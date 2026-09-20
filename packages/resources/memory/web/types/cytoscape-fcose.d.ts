/**
 * `cytoscape-fcose` 布局扩展的类型垫片。
 *
 * 上游包（2.2.0）只发布 JS、也没有 `@types/cytoscape-fcose`；原声明在宿主
 * `apps/web/src/types/cytoscape-fcose.d.ts`，随本包 `web/` 面下沉而留在宿主。
 * 本包是 `cytoscape-fcose` 的唯一导入方（`web/pages/hindsight/components/Graph2d.tsx`），
 * 声明因此归本包：消费方（含未来的宿主 WebShell）不应依赖宿主的 d.ts，宿主那份在本包页面
 * 完成重接线后可删（归 §1.6）。
 *
 * 已知限制：shorthand 声明把整个模块视为 `any`（与宿主原声明同口径），不校验 `cytoscape.use()`
 * 的入参形状；`Graph2d.tsx` 侧用显式类型标注守住布局选项。移除条件：上游自带类型或社区发布
 * `@types/cytoscape-fcose`。
 */
declare module "cytoscape-fcose";
