/**
 * 目录类型 → 自有组件的模块级注册表（计划 §5.2 / §5.3）。
 *
 * 两条硬约束：
 *
 * 1. **键集与 `catalog.ts` 严格相等**。`Record<UISpecTypeName, …>` 让「目录加了类型而注册表没接线」
 *    在编译期就失败；查表再走 `Map`，不经原型链 —— `constructor` / `__proto__` / `toString` 一类
 *    type 会落到 `undefined`，由 `UISpecView` 原地占位（§1.5 L3 目录）。
 *
 * 2. **只消费 schema 结果**。`resolveElement` 已用 `uiSpecCatalog[type].props`（`strictObject`）
 *    校验过 props，这里是唯一的适配层：把该对象**窄化**成组件自己的 props 类型（`z.infer` 取同一张
 *    schema 的推断结果，不手抄字段），再显式取字段传给组件。不读 raw props、不整对象展开给组件或 DOM，
 *    `envId` / `style` / `onClick` 一类的额外键到不了这里（`strictObject` 在 parse 侧已判 invalid-props）。
 *
 * 叶节点（Text / Table）不接收 children：目录里它们没有 `container: true`，parse 已把「已知叶节点带
 * 非空 children」判为 structure；传入的 children 在此不渲染。
 */

import type { ComponentType, ReactNode } from "react";
import type { UISpecTypeName } from "./catalog";
import { StackView, type StackViewProps } from "./components/StackView";
import { TableView, type TableViewProps } from "./components/TableView";
import { TextView, type TextViewProps } from "./components/TextView";

/** 注册表条目的渲染输入：`props` 是校验后的字段袋，`children` 是 `UISpecView` 已渲染好的子树。 */
export interface UISpecRegistryProps {
  props: Record<string, unknown>;
  children?: ReactNode;
}

function StackEntry({ props, children }: UISpecRegistryProps) {
  const { gap } = props as StackViewProps;
  return <StackView gap={gap}>{children}</StackView>;
}

function TextEntry({ props }: UISpecRegistryProps) {
  const { text, tone } = props as TextViewProps;
  return <TextView text={text} tone={tone} />;
}

function TableEntry({ props }: UISpecRegistryProps) {
  const { caption, columns, rows, align } = props as TableViewProps;
  return <TableView caption={caption} columns={columns} rows={rows} align={align} />;
}

/** 目录 ←→ 实现的对照表：键即类型名，漏一个或多个一个都在 `tsc` 阶段报错。 */
const uiSpecComponents: Record<UISpecTypeName, ComponentType<UISpecRegistryProps>> = {
  Stack: StackEntry,
  Text: TextEntry,
  Table: TableEntry,
};

/** 查表入口：own-key 语义的 `Map`，`constructor` 这类字符串取不到任何实现。 */
export const uiSpecRegistry: ReadonlyMap<string, ComponentType<UISpecRegistryProps>> = new Map(
  Object.entries(uiSpecComponents),
);
