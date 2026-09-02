// Peri Task capability 协商的单一事实来源。
//
// acp-link 已实现以下 Peri 扩展能力的消费与安全转发，因此 initialize 始终声明对应
// `_meta` capability。Peri 据此决定是否发射事件；主服务不再维护第二个功能开关。

export const PERI_TOKEN_STATS_CAPABILITY = "peri.tokenStats";
export const PERI_AGENT_EVENT_CAPABILITY = "peri.agentEvent";
export const PERI_UNSTABLE_EVENT_CAPABILITY = "peri.unstableEvent";
export const PERI_AGENT_EVENT_METHOD = "peri/agent_event";
export const PERI_UNSTABLE_EVENT_METHOD = "peri/unstable_event";

/** 返回 acp-link 实际支持的 Peri capability。 */
export function buildPeriCapabilityMeta(): Record<string, true> {
  return {
    [PERI_TOKEN_STATS_CAPABILITY]: true,
    [PERI_AGENT_EVENT_CAPABILITY]: true,
    [PERI_UNSTABLE_EVENT_CAPABILITY]: true,
  };
}

/** 仅放行 acp-link 已实现并由主服务规范化的扩展 notification。 */
export function isPeriTaskNotificationMethod(method: string): boolean {
  return method === PERI_AGENT_EVENT_METHOD || method === PERI_UNSTABLE_EVENT_METHOD;
}
