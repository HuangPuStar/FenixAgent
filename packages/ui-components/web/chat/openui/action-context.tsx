/**
 * OpenUI 动作宿主上下文：把「点击 OpenUI 按钮后消息发往哪里」交给聊天外壳注入。
 *
 * 为什么用 Context 而不是 prop：动作按钮渲染在 SDK 的组件树深处（`OpenUIProgram` →
 * `Renderer` → `ButtonView`），中间隔着一层第三方渲染器，逐层透传会把宿主端口写进第三方组件的
 * 调用链。Context 让 `OpenUIBlock` 只取一次，缺省为 null 时动作整体禁用。
 */

import type { OpenUIActionEvent } from "@peri-code/sdk/openui";
import { createContext, type ReactNode, useContext } from "react";

/** 宿主注入的 OpenUI 动作处理器；`enabled` 为假时按钮保持禁用（例如 turn 运行中）。 */
export interface OpenUIActionHandler {
  readonly enabled: boolean;
  readonly send: (event: OpenUIActionEvent) => void;
}

const OpenUIActionContext = createContext<OpenUIActionHandler | null>(null);

export interface OpenUIActionProviderProps {
  value: OpenUIActionHandler;
  children: ReactNode;
}

export function OpenUIActionProvider({ value, children }: OpenUIActionProviderProps) {
  return <OpenUIActionContext.Provider value={value}>{children}</OpenUIActionContext.Provider>;
}

/** 取宿主动作处理器；没有 Provider 时返回 null（按钮禁用、不发送）。 */
export function useOpenUIAction(): OpenUIActionHandler | null {
  return useContext(OpenUIActionContext);
}
