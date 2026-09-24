/**
 * 工具 / 参数分组的折叠容器：`▶ 组名` 标题行 + 展开后的内容区。
 *
 * 为什么有这个共享件（2026-09-23 第 19 轮，§4.1 的「已有组件禁止重复开发」）：此前同名的
 * `CollapsibleGroup` 在本包内有两份实现，props 形状逐字相同（`label` / `defaultOpen` / `children`）、
 * 用途也相同（「默认组展开 + advance 组折叠」的分组展示），只是一个用原生
 * `<details>`（`components/node-config-fields.tsx`，节点配置卡的工具分组）、另一个用组件内 `useState`
 * + `ParamGroupHeader`（`components/RunParamsDialog.tsx`，运行参数弹窗的分组）。两处的调用形态完全一致
 * （`groups.length > 1` 时 `map` 出若干个 `CollapsibleGroup`），差异只在标题行的呈现。
 *
 * 收敛到**一份**：标题行复用本包既有的受控件 `ParamGroupHeader`（`ParamsEditor` 与运行参数弹窗都用它，
 * 全包的参数 / 工具分组标题自此只有一种长相），展开态由本组件持有——调用方只给 `defaultOpen`，
 * 与两处旧实现的调用契约一致。视觉差异已记账：节点配置卡的工具分组由原生三角标改成 `▶`（字号、字重、
 * 颜色与旧 `summary` 相同），并与本包其它分组标题统一。
 *
 * 为什么不上移到 `@fenix/ui-components`：消费者都在本包（§4.1「归属由消费者集合决定」，
 * 只有一个包的消费者时留在原处，不做推测性抽象）。
 */

import { useState } from "react";
import { ParamGroupHeader } from "./ParamGroupHeader";

interface CollapsibleGroupProps {
  label: React.ReactNode;
  /** 首次挂载时的展开态；之后的展开 / 收起由本组件自己持有。 */
  defaultOpen: boolean;
  children: React.ReactNode;
}

export function CollapsibleGroup({ label, defaultOpen, children }: CollapsibleGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginTop: 8, marginBottom: 8 }}>
      <ParamGroupHeader label={label} open={open} onToggle={() => setOpen((value) => !value)} />
      {open && <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>}
    </div>
  );
}
