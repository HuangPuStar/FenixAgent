// agent-organizations-classes.ts
// 组织页四处原生 `<select>`（默认执行节点、成员角色、邀请角色、机器引擎）的共有外观。
//
// 为什么收成一个常量：原 `agent-organizations.css` 用一条分组选择器
// `.org-engine-strip select, .org-list-actions select, .org-dialog-fields select` 表达「这四处是同一条规则」，
// 换成工具类后同一条类串会散到 `agent-organizations-workspace.tsx` 与 `agent-organizations-dialogs.tsx`
// 共 4 处——收口到一处，外观调整只需改这里（与 `knowledge-typography.ts`、`observer-meta-classes.ts` 同一口径）。
//
// 为什么保留原生 `<select>` 而不换库内 `ui/select`：后者是 Radix 弹层组件，会改变交互方式与 DOM 结构，
// 超出本次「样式换成工具类」的范围（契约不动：交互与结构行为一律保持）。
//
// 字号 `text-sm`：原 12px 档。刻度已在 `@theme` 按 px 落地（`--text-sm: 14px`），工具类写的就是设计值，
// 与根字号无关——旧注记「宿主 13px 根字号让 rem 刻度按 13/16 渲染、实测 `text-sm` = 11.375px」随令牌层
// 改造作废。这一档现在比原值大 2px，是否换回 `text-xs`(=12px) 属另一批裁定，本批不动值。
export const ORG_SELECT_CLASS =
  "min-h-8.5 rounded-md border border-slate-200 bg-white py-0 pr-7.5 pl-2.5 text-sm text-slate-600";
