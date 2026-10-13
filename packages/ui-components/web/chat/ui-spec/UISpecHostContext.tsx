/**
 * `ui-spec` 的宿主上下文：把宿主侧信息（当前 `envId`）交给渲染层。
 *
 * 为什么必须是 Context（计划 §1.2）：renderer 是模块级常量，而 `CustomRendererProps` 只给
 * `code / isIncomplete / language / meta`（streamdown `index.d.ts`），宿主环境没有别的通道进渲染层；
 * 同理**不能用模块级 `currentEnvId`** —— 消息流里可能同时挂载多个环境的消息，模块级变量会让后挂载者
 * 覆盖先挂载者，两个 Provider 的 envId 必须天然隔离。
 *
 * 为什么 Provider 挂在 `MessageResponse` 内（§1.1 / §1.2）：包根或聊天外壳上挂一层只能覆盖该层的
 * 子树，而 renderer 由 streamdown 在消息内部调用，宿主信息必须与消息同步；`value` 由调用方
 * `useMemo` 稳定引用（本组件不做浅比较记忆化）。
 *
 * 切片 1 的三条目录能力（Stack / Text / Table）都**不消费** `envId`，也不发任何请求：本上下文此刻
 * 只保证「隔离 + 不可被 Spec 覆盖」两条契约，是未来资源类组件（Link / Image）的唯一入口。
 */

import { createContext, type ReactNode, useContext } from "react";

/** 宿主注入的上下文值（§1.2 冻结名）。字段可选：未挂 Provider 时组件必须仍能渲染。 */
export interface UISpecHostContext {
  /** environmentId，宿主文件代理路由用；本包不定义该路由，也不从 Spec 读取它。 */
  envId?: string;
}

/** 默认空对象：未挂 Provider 时 `useUISpecHost()` 返回它，而不是抛错（消息区可能被宿主单独复用）。 */
const uiSpecHostContext = createContext<UISpecHostContext>({});

export interface UISpecHostProviderProps {
  /** 宿主侧上下文；由调用方负责引用稳定（如 `useMemo(() => ({ envId }), [envId])`）。 */
  value: UISpecHostContext;
  children?: ReactNode;
}

/** 宿主注入点：包在会渲染 `ui-spec` 的子树外层。 */
export function UISpecHostProvider({ value, children }: UISpecHostProviderProps) {
  return <uiSpecHostContext.Provider value={value}>{children}</uiSpecHostContext.Provider>;
}

/** 渲染层读取入口。Spec 无法写入本上下文：它只经 Provider 的 `value` 传入。 */
export function useUISpecHost(): UISpecHostContext {
  return useContext(uiSpecHostContext);
}
