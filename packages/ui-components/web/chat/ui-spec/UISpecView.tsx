/**
 * 校验结果 → 自有组件树的遍历层（计划 §5.2 的 `UISpecView`）。
 *
 * 输入契约：`spec` 只接 `parseUISpec` 的成功产物（§1.4）——引用完整性、成环、多父、可达性与全部限额
 * 已由 parse 拦下。本层不复验这些规则，只做两件事：把元素交给 `resolveElement` 判类型与 props、
 * 按注册表渲染；**没法渲染的元素原地占位**，兄弟节点与父级继续（§1.5 L3）。
 *
 * 为什么整模块可 lazy（§5.2 懒加载边界）：组件与注册表是 Spec 路径独有的代码，消息里没有
 * `ui-spec` 围栏时不该付这份成本；Suspense 与错误边界由静态模块 `UISpecBlock` 提供。
 *
 * 安全（§1.7）：Spec 的全部字符串只作 React 文本节点；类型名（来自 Spec、可能很长或形如
 * `constructor`）按同一张限额截断后同样只作文本。本层不接收 raw props、不展开到 DOM、不发请求。
 */

import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { resolveElement } from "./parse";
import { uiSpecRegistry } from "./registry";
import { UI_SPEC_LIMITS, type UISpec } from "./spec";

/** 递归深度与渲染节点数都按 parse 的同一张限额兜底：宿主若绕过 parse 直接传 spec，这里仍是有界的。 */
const MAX_DEPTH = UI_SPEC_LIMITS.maxDepth;
const MAX_NODES = UI_SPEC_LIMITS.maxElements;

/** 走不通的元素呈现：一行受限类型名，不渲染子树，不给出任何可交互能力。 */
function UISpecPlaceholder({ text }: { text: string }) {
  return (
    <span
      data-slot="ui-spec-placeholder"
      className="inline-flex max-w-full min-w-0 items-center rounded-md border border-dashed border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
    >
      {text}
    </span>
  );
}

export function UISpecView({ spec }: { spec: UISpec }) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  /** 本次渲染的节点预算：合法 spec ≤ maxElements，越界只可能来自未校验输入。 */
  const budget = { remaining: MAX_NODES };

  const typeName = (value: string) => value.slice(0, UI_SPEC_LIMITS.maxTypeChars);

  const renderNode = (id: string, depth: number): ReactNode => {
    if (depth > MAX_DEPTH || budget.remaining <= 0) return null;
    if (!Object.hasOwn(spec.elements, id)) return null;
    const element = spec.elements[id];
    if (!element) return null;

    const resolution = resolveElement(element);
    budget.remaining -= 1;

    if (resolution.status === "unsupported") {
      return (
        <UISpecPlaceholder text={t("chat.components.uiSpec.unsupportedType", { type: typeName(resolution.type) })} />
      );
    }
    if (resolution.status === "invalid-props") {
      return <UISpecPlaceholder text={t("chat.components.uiSpec.invalidProps", { type: typeName(resolution.type) })} />;
    }

    const Entry = uiSpecRegistry.get(resolution.type);
    if (!Entry) {
      // 目录新增了类型而注册表未接线：按未知类型处理，不猜测实现。
      return (
        <UISpecPlaceholder text={t("chat.components.uiSpec.unsupportedType", { type: typeName(resolution.type) })} />
      );
    }

    return (
      <Entry key={id} props={resolution.props}>
        {resolution.children.map((childId) => (
          <Fragment key={childId}>{renderNode(childId, depth + 1)}</Fragment>
        ))}
      </Entry>
    );
  };

  return <>{renderNode(spec.root, 1)}</>;
}
