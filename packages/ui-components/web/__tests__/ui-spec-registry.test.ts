// web/__tests__/ui-spec-registry.test.ts
// 目录 ↔ 注册表的对齐守卫（计划 §5.4 第 2 项）。
//
// 为什么必须有这一层：`registry.tsx` 里的 `Record<UISpecTypeName, …>` 只提供**编译期**完备性检查，
// 它拦不住「运行时键集被改歪」（例如实现改成按字符串查表、或有人用 `Object.fromEntries` 拼了一份
// 含原型键的表）。本文件从**运行时**读 `uiSpecRegistry` 与 `uiSpecCatalog`，把三条契约钉死：
//
// 1. 键集双向严格相等；
// 2. 每个值都是合法可渲染组件（`typeof === "function"` 不足以判定：memo / forwardRef 是带 `$$typeof`
//    标记的对象，用它判否会把合法条目误杀）；
// 3. 数据驱动的渲染冒烟 —— 类型清单与 props 全部从目录派生（不硬编码类型名），所以「目录新增了类型
//    但注册表条目坏掉」会自动失败，而不需要有人记得来改这个文件。
//
// 与 `ui-spec-render.test.tsx` 的分工：那边跑的是手写的端到端场景（容器锚点、降级、DOM 文本安全、
// 上下文隔离）；这里只回答「目录里的每个类型是否都有可渲染的实现」，不重复那些场景。

import { describe, expect, test } from "bun:test";
import { createElement, memo, type ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { z } from "zod/v4";
import { isCatalogType, uiSpecCatalog } from "../chat/ui-spec/catalog";
import { resolveElement } from "../chat/ui-spec/parse";
import { type UISpecRegistryProps, uiSpecRegistry } from "../chat/ui-spec/registry";
import type { UISpecElement } from "../chat/ui-spec/spec";

/**
 * 生成的 JSON Schema 里本文件要读的字段（其余字段不参与生成）。
 *
 * 注意 `z.toJSONSchema` 是重载函数（schema 版 / registry 版），`Parameters<…>[0]` 取到的是**最后一个**
 * 重载（registry），拿它当 schema 类型会把真实 schema 值判成不可传参。这里显式用 zod 的 schema 基类型
 * （`z.ZodType`，即文档里 `$ZodType` 的经典写法），目录属性访问的联合值直接可传。
 */
type CatalogSchema = z.ZodType;

/** 生成的 JSON Schema 结构。 */
interface SchemaNode {
  type?: string;
  enum?: unknown[];
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  minItems?: number;
}

/** 运行时类型清单：只从目录取，本文件不硬编码任何类型名。 */
const CATALOG_KEYS = Object.keys(uiSpecCatalog);

/** 容器类型的 children 探针：用来证明 registry 真的把子树交到了组件手里。 */
const CHILD_PROBE = "registry-child-probe";

/**
 * 「可渲染组件」判定：函数组件 / 类组件是 `function`；`memo`、`forwardRef`、`lazy` 是**对象**，
 * 靠 `$$typeof` 标记识别。刻意不写成 `typeof value === "function"` —— 那会把合法的 memo 条目判非法。
 */
function isRenderableComponent(value: unknown): boolean {
  if (typeof value === "function") return true;
  return typeof value === "object" && value !== null && typeof (value as { $$typeof?: unknown }).$$typeof === "symbol";
}

/** 从目录 schema 生成「最小合法 props」的入口；根必须是对象。 */
function minimalProps(schema: CatalogSchema): Record<string, unknown> {
  const generated = minimalValue(z.toJSONSchema(schema) as unknown as SchemaNode, "");
  if (typeof generated !== "object" || generated === null || Array.isArray(generated)) {
    throw new Error("目录 schema 的根不是对象，无法生成最小 props");
  }
  return generated as Record<string, unknown>;
}

/**
 * 最小实例生成：只取 `required` 字段，数组按 `minItems` 造最短长度，字符串造带路径的可检索样本值。
 * 样本值带路径（`sample-rows-0-0`）是为了后面能在渲染输出里逐个找回「喂进去的内容」。
 *
 * 覆盖范围是当前目录用到的 schema 形态（枚举 / 字符串 / 数字 / 布尔 / 数组 / 对象）。将来某个类型用到这里
 * 没有的约束（如 `pattern`、联合类型），生成值会被 `resolveElement` 拒绝 —— 上层的 `status: "ok"` 断言
 * 会带着类型名失败，要求实现者过一遍本文件，而不是静默跳过该类型。
 */
function minimalValue(node: SchemaNode, path: string): unknown {
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
  switch (node.type) {
    case "string":
      return `sample-${path || "value"}`;
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    case "array": {
      const items = node.items ?? {};
      return Array.from({ length: node.minItems ?? 0 }, (_, index) => minimalValue(items, `${path}-${index}`));
    }
    case "object": {
      const properties = node.properties ?? {};
      const generated: Record<string, unknown> = {};
      for (const key of node.required ?? []) {
        generated[key] = minimalValue(properties[key] ?? {}, path ? `${path}-${key}` : key);
      }
      return generated;
    }
    default:
      return null;
  }
}

/** 递归收集 props 里的字符串值：它们都要在渲染输出里找得到。 */
function collectStrings(value: unknown, collected: string[] = []): string[] {
  if (typeof value === "string") {
    collected.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, collected);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectStrings(item, collected);
  }
  return collected;
}

/** SSR 成标记：三个自有组件与 registry 都不依赖 DOM 与 i18n，够证明「条目真的渲染出了内容」。 */
async function renderToMarkup(element: ReactNode): Promise<string> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

describe("ui-spec 注册表对齐", () => {
  // 键集必须双向严格相等：少一个是「目录新增类型没接线」，多一个是「注册表挂了目录里没有的类型」。
  test("registry 与 uiSpecCatalog 的键集双向严格相等", () => {
    expect(CATALOG_KEYS.length).toBeGreaterThan(0);

    const registryKeys = [...uiSpecRegistry.keys()].sort();
    expect(registryKeys).toEqual([...CATALOG_KEYS].sort());

    // 两个方向各判一次，失败信息直接指出是哪一个键（集合相等本身不告诉方向）。
    expect(CATALOG_KEYS.filter((key) => !uiSpecRegistry.has(key))).toEqual([]);
    expect([...uiSpecRegistry.keys()].filter((key) => !isCatalogType(key))).toEqual([]);
  });

  // 每个值都必须是可渲染组件：memo / forwardRef 这类对象形态同样算合法，不能用 typeof 判否。
  test("每个 registry 值都是合法可渲染组件（memo / forwardRef 形态不被误杀）", () => {
    // 判定谓词自证：三种合法形态都要通过，否则下面那条断言只是 typeof 判定的马甲。
    expect(isRenderableComponent(() => null)).toBe(true);
    expect(isRenderableComponent(memo(() => null))).toBe(true);
    // forwardRef 的真实标记由 React 内部的 `Symbol.for` 提供，这里只验谓词的「带标记对象」分支。
    expect(isRenderableComponent({ $$typeof: Symbol.for("react.forward_ref") })).toBe(true);
    expect(isRenderableComponent({})).toBe(false);
    expect(isRenderableComponent("Stack")).toBe(false);
    expect(isRenderableComponent(undefined)).toBe(false);

    expect(CATALOG_KEYS.filter((key) => !isRenderableComponent(uiSpecRegistry.get(key)))).toEqual([]);
  });

  // 数据驱动渲染冒烟：类型清单与 props 都从目录派生，目录新增类型时本用例自动覆盖到。
  test("遍历目录全部类型：按 schema 生成最小合法 props 各渲染一次，并输出真实内容", async () => {
    expect(CATALOG_KEYS.length).toBeGreaterThan(0);

    // 判定力自检：渲染成空的组件必须**不**满足下面这两条判定，否则本用例是空转的。
    const emptyMarkup = await renderToMarkup(createElement(() => null));
    expect({ render: "empty-component", slot: emptyMarkup.includes('data-slot="ui-spec-') }).toEqual({
      render: "empty-component",
      slot: false,
    });
    expect({ render: "empty-component", probe: emptyMarkup.includes(CHILD_PROBE) }).toEqual({
      render: "empty-component",
      probe: false,
    });

    for (const type of CATALOG_KEYS) {
      // 类型收窄用目录自己的 own-property 判定（键集一致性已由上一条用例断言）。
      if (!isCatalogType(type)) continue;
      const catalogEntry = uiSpecCatalog[type];

      const generated = minimalProps(catalogEntry.props);
      const resolution = resolveElement({ type, props: generated } satisfies UISpecElement);
      expect({ type, status: resolution.status }).toEqual({ type, status: "ok" });
      if (resolution.status !== "ok") continue;

      const component = uiSpecRegistry.get(type);
      expect({ type, registered: Boolean(component) }).toEqual({ type, registered: true });
      if (!component) continue;

      // `container` 只标在容器类型上（目录条目的联合因此没有统一属性）：按 own-property 收窄，
      // 而不是对联合整体断言 —— 叶类型（Text / Table）没有这个字段，断言整体会在类型层失真。
      const isContainer = "container" in catalogEntry && catalogEntry.container === true;
      const props: UISpecRegistryProps = {
        props: resolution.props,
        ...(isContainer ? { children: createElement("span", null, CHILD_PROBE) } : {}),
      };
      const markup = await renderToMarkup(createElement(component, props));

      // 自有组件的根节点都带 `ui-spec-` 前缀的 data-slot：连这条都没有，说明条目渲染成了空。
      expect({ type, rendered: markup.includes('data-slot="ui-spec-') }).toEqual({ type, rendered: true });

      // 「真实内容」：喂进去的每个字符串都要出现在输出里；容器类型另有 children 探针，
      // 证明子树真的被消费（Stack 不渲染 children 是本条要拦的退化）。
      const markers = [...collectStrings(generated), ...(isContainer ? [CHILD_PROBE] : [])];
      for (const marker of markers) {
        expect({ type, marker, found: markup.includes(marker) }).toEqual({ type, marker, found: true });
      }
    }
  });

  // 原型名既不是目录类型、也查不到实现（§1.5 L3 目录）：查表必须 own-key 语义，不能走原型链。
  test("constructor / toString / __proto__ 一类原型名不是目录类型，也查不到实现", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect({ name, catalogType: isCatalogType(name) }).toEqual({ name, catalogType: false });
      expect({ name, implementation: uiSpecRegistry.get(name) }).toEqual({ name, implementation: undefined });
    }
  });
});
