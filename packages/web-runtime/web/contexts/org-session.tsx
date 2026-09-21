// web/contexts/org-session.tsx
// 「我在哪个组织、我是谁」的**契约**：React context + 单 hook，实现方是身份包。
//
// 为什么契约落在本包而不是 `@fenix/identity/web`（§1.6 T7 用户裁定）：
// 资源包（skill / mcp / knowledge / model-management / agent-config）需要组织与会话上下文来判断
// 资源归属，但 §2.3 禁止 `resources` 依赖具体平台实现（`platform/identity`）。把 context 的
// **形状**放到中性的 `web-runtime`，身份包只做投影，资源包便只依赖稳定契约。
//
// 为什么是 projection 而不是直接 re-export 身份的 context：值必须来自**同一份实现**——
// `OrgProvider` 的取数、切换与 fetch 头注入属于身份域，不能下沉到本包；本包只声明资源包需要的
// 最小投影（组织 id / 用户 id / 是否组织 owner / 是否就绪）。身份的 `OrgProvider` 挂本 Provider
// 并把自己的状态投影进来，Shell 在 `__root` 装配，资源包经 `useOrgSession()` 读取。
//
// **context 实例单一性**：本文件是 `OrgSessionContext` 的唯一 `createContext` 站点。第二份会让
// 资源包永远读到 `null` 并抛出，而现象只是「权限判定全体失效」，很难从界面反推——故资源包
// 自己的 `contexts-no-createContext` 类守卫把这些包内的 `createContext` 判为违规。
//
// 投影刻意不含身份域的角色枚举：`isOwner` 是资源包真实需要的粒度（组织 owner 可管理他人资源），
// 角色字符串（`owner` / `admin` / `member`）属身份域词汇，不外泄到每个资源包的类型面。
// 需要更细粒度时按「第二个真实用例出现才抽象」补字段，不预留。

import { createContext, type ReactNode, useContext } from "react";

/** 资源包可见的组织与会话上下文投影。全字段可空/可假，消费方必须自己处理未就绪态。 */
export interface OrgSession {
  /** 当前激活组织 id；未解析出组织时为 `null`（此时不得用空串冒充）。 */
  organizationId: string | null;
  /** 当前登录用户 id（来自会话）；未登录或会话未就绪时为 `null`。 */
  userId: string | null;
  /** 当前用户是否为激活组织的 owner。非 owner、角色未知与未就绪一律为 `false`。 */
  isOwner: boolean;
  /** 上下文是否仍在解析（组织列表或会话未就绪）。`true` 时上面的字段都不代表最终值。 */
  pending: boolean;
}

const OrgSessionContext = createContext<OrgSession | null>(null);

/** 契约的实现侧入口：由身份的 `OrgProvider` 在自己的状态上投影出 `value` 后挂载。 */
export function OrgSessionProvider({ value, children }: { value: OrgSession; children: ReactNode }) {
  return <OrgSessionContext.Provider value={value}>{children}</OrgSessionContext.Provider>;
}

/** 读取组织与会话上下文投影；不在 `OrgSessionProvider` 内时抛出（不静默回落默认值）。 */
export function useOrgSession(): OrgSession {
  const ctx = useContext(OrgSessionContext);
  if (!ctx) {
    throw new Error("useOrgSession must be used within OrgSessionProvider（由身份的 OrgProvider 挂载）");
  }
  return ctx;
}
