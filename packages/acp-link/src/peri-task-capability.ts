// packages/acp-link/src/peri-task-capability.ts
// Peri Task View capability 协商的单一事实来源（切片 0B）。
//
// acp-link 可能运行在独立 machine 进程（与主服务非同进程），不能假设宿主环境
// 变量天然可见。capability 开关通过显式 typed config 读取：
// - 默认 false（不声明 capability → Peri 源头不发射，行为与既有版本完全一致）；
// - 宿主开启 RCS_PERI_TASK_VIEW_ENABLED 并经 launchSpec.env 透传同名变量到
//   machine 进程后，本模块返回 true；
// - 需要启动参数注入的场景调用 setPeriTaskCapabilityEnabled 覆盖（优先于环境变量）。
//
// capability key 使用完整 `_meta` key（`peri.agentEvent` / `peri.unstableEvent`），
// Peri 侧经 peri-acp-types/src/peri_caps.rs:67-84 的 from_client_meta 解析，
// 全部 flag 默认关闭（peri_caps.rs:5-9），声明后 Peri 才会发射对应通道。

export const PERI_AGENT_EVENT_CAPABILITY = "peri.agentEvent";
export const PERI_UNSTABLE_EVENT_CAPABILITY = "peri.unstableEvent";

/** peri/* 通知 method（extNotification 转发白名单） */
export const PERI_AGENT_EVENT_METHOD = "peri/agent_event";
export const PERI_UNSTABLE_EVENT_METHOD = "peri/unstable_event";

let capabilityEnabled = process.env.RCS_PERI_TASK_VIEW_ENABLED === "true";

/** 当前是否声明 Peri Task capability（默认 false；env 或 setPeriTaskCapabilityEnabled 开启） */
export function isPeriTaskCapabilityEnabled(): boolean {
  return capabilityEnabled;
}

/** 启动方显式注入（优先于环境变量；用于 machine 端以启动参数传入开关的场景） */
export function setPeriTaskCapabilityEnabled(enabled: boolean): void {
  capabilityEnabled = enabled;
}

/** capability 声明（_meta 段）；关闭时返回空对象，不改变既有 initialize 行为 */
export function buildPeriCapabilityMeta(): Record<string, boolean> {
  if (!capabilityEnabled) return {};
  return {
    [PERI_AGENT_EVENT_CAPABILITY]: true,
    [PERI_UNSTABLE_EVENT_CAPABILITY]: true,
  };
}

/**
 * 是否应转发该 notification method（extNotification 白名单）。
 * 只允许 peri/* 两个已知 method 进入 relay；其他未知 notification 保持 SDK
 * 默认行为（静默忽略），不暴露任意 Peri 控制事件。
 */
export function isPeriTaskNotificationMethod(method: string): boolean {
  return capabilityEnabled && (method === PERI_AGENT_EVENT_METHOD || method === PERI_UNSTABLE_EVENT_METHOD);
}
