// web/__tests__/react-i18next-stub.ts
// 知识库两个组件用例（`agent-knowledge-bases-page-states` / `knowledge-panel-load-failure-states`）
// 共用的 `react-i18next` 替身注册器。抽成共享模块的原因有两条：
//   1. 两个文件的口径必须完全一致——都是「渲染真实 i18next 实例 + 本包字典，断言本包 `TEXT`」，
//      替身分头维护迟早漂移；
//   2. bun 1.4.2 的 `mock.module` 是**进程级**注册（`bun test packages/` 单进程跑完所有包，
//      channel / mcp / skill 等同批文件注册的是 `t: (key) => key` 的替身），所以两个文件都必须
//      自己注册；替身各自再抄一遍会把两处都顶到 500 行的单文件上限附近。
//
// 替身的语义与真实库对齐，不能简化：
//   - `I18nextProvider` 必须把**调用方传入的实例**放进 context（真实库就是这么分发的）。同包的
//     `knowledge-access-denied.test.tsx` 故意用空字典实例断言 `t` 回显 key，替身若忽略 provider
//     一律回落到本文件的实例，那条用例会拿到真实文案而失真（实测过的回归）。
//   - `t` 必须是**按「实例 + 命名空间」缓存的稳定引用**：组件把 `t` 写进了请求 effect 的依赖数组，
//     每次渲染换一个新函数会让 effect 反复重跑（实测请求会打满 5s 超时）。
//   - 除 `useTranslation` / `I18nextProvider` 外还要给出 `initReactI18next` 与 `Trans`：bun 1.4.2 下
//     替身命名空间会被同进程后续文件复用，缺出口会让之后加载的组件（如 identity 的弹窗）渲染期抛错。

import { mock } from "bun:test";
import type { createInstance } from "i18next";
import { createContext, createElement, type ReactNode, useContext } from "react";
import { KNOWLEDGE_NS } from "../i18n";

type I18nInstance = ReturnType<typeof createInstance>;

type Translator = (key: string, options?: Record<string, unknown>) => string;

/** 替身版 `I18nextProvider` 放置实例的上下文，语义与真实库的 context 一致。 */
const StubI18nContext = createContext<I18nInstance | null>(null);

/**
 * `t` 的稳定引用缓存（按「实例 + 命名空间」）：同一实例 + 同一命名空间始终返回同一个函数，
 * 避免组件里把 `t` 放进 effect 依赖数组时反复重跑。
 */
const fixedTranslators = new WeakMap<object, Map<string, Translator>>();

/** 取指定实例 + 命名空间上绑定的 `t`（未指定命名空间时用实例的 defaultNS）。 */
function translatorFor(instance: I18nInstance, namespace?: string): Translator {
  const ns = namespace ?? KNOWLEDGE_NS;
  let byNamespace = fixedTranslators.get(instance);
  if (!byNamespace) {
    byNamespace = new Map();
    fixedTranslators.set(instance, byNamespace);
  }
  let t = byNamespace.get(ns);
  if (!t) {
    t = instance.getFixedT(null, ns) as unknown as Translator;
    byNamespace.set(ns, t);
  }
  return t;
}

/**
 * 注册 `react-i18next` 替身。`fallback` 是「没有 provider 时用哪个实例」（用例注入的真实实例，
 * 挂着本包字典）。必须在被测组件被 import 之前调用（两个用例文件都在模块作用域调用）。
 */
export function registerReactI18nextStub(fallback: I18nInstance): void {
  mock.module("react-i18next", () => ({
    initReactI18next: { type: "3rdParty", init: () => {} },
    Trans: ({ children }: { children?: unknown }) => children,
    /** 与真实库同语义：把 provider 传入的实例放进 context，供子树里的 `useTranslation` 取用。 */
    I18nextProvider: ({ i18n: instance, children }: { i18n?: I18nInstance; children?: unknown }) =>
      createElement(StubI18nContext.Provider, { value: instance ?? null }, children as ReactNode),
    /**
     * `t` 委托给 provider 传入的真实实例（本用例注入的就是挂本包字典那份）：字典与断言取的 `TEXT`
     * 同源，不必另抄一份替身表，也就不会出现「字典换了、断言还是旧的」。
     */
    useTranslation: (namespace?: string) => {
      const instance = useContext(StubI18nContext) ?? fallback;
      return { t: translatorFor(instance, namespace), i18n: instance };
    },
  }));
}
