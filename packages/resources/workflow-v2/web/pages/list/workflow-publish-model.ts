// pages/list/workflow-publish-model.ts
// **发布日志弹窗**的纯派生：上游发布记录的视图模型、状态 → 文案键与时间格式化。
//
// 控制台发布入口已撤除（发布动作在上游侧完成，列表页只读上游发布状态）；`PUBLISH_ACTION_RESULT_KEYS` 保留，
// 继续服务弹窗里「平台发布动作」区的历史审计展示。
//
// 返回 i18n **键**而不是文案（键是有限枚举，可被包内 i18n 用例逐个查字典）；文案取值属视图层（§9.1）。

/**
 * 发布记录的视图模型：把上游字段定型成「上屏什么」，组件不再做 null 分支。
 *
 * 只搬运上游真实有的字段：版本号、渠道结果、打包失败明细。上游记录里没有时间与操作人（thrift 无此字段），
 * 记录级 `publish_status` 在该构建恒为 0（服务端据此改为由渠道结果派生 `status`）——三者都不在视图模型里，
 * 组件也就无从把它们画出来（禁止幻造字段）。
 */
export interface WorkflowPublishRecordRow {
  readonly key: string;
  /** 版本号；上游未给时为 null（由组件显示「上游未提供」）。 */
  readonly version: string | null;
  readonly status: "done" | "pack_failed" | "in_progress";
  /** 渠道结果：名称缺失时用渠道 ID 兜底，状态缺失时由组件显示「未知」。 */
  readonly channels: readonly {
    readonly key: string;
    readonly name: string;
    readonly status: "success" | "failed" | "auditing" | "in_progress" | "disabled" | null;
  }[];
  readonly packFailedResources: readonly string[];
}

/** 记录行的键：版本号缺失时用序号兜底（记录可能既无版本也无 id，必须保证 React key 唯一且稳定）。 */
export function toPublishRecordRow(
  record: {
    readonly version: string | null;
    readonly status: "done" | "pack_failed" | "in_progress";
    readonly channels: readonly {
      readonly connectorId: string | null;
      readonly connectorName: string | null;
      readonly status: "success" | "failed" | "auditing" | "in_progress" | "disabled" | null;
    }[];
    readonly packFailedResources: readonly string[];
  },
  index: number,
): WorkflowPublishRecordRow {
  return {
    key: record.version ?? `record-${index}`,
    version: record.version,
    status: record.status,
    channels: record.channels.map((channel, channelIndex) => ({
      key: channel.connectorId ?? `channel-${channelIndex}`,
      name: channel.connectorName ?? channel.connectorId ?? `${channelIndex}`,
      status: channel.status,
    })),
    packFailedResources: record.packFailedResources,
  };
}

/** 记录级状态 → 字典键（导出成键表，供包内 i18n 用例枚举，改键只有这一处）。 */
export const PUBLISH_RECORD_STATUS_KEYS = {
  done: "log.record_status.done",
  pack_failed: "log.record_status.pack_failed",
  in_progress: "log.record_status.in_progress",
} as const;

/** 渠道状态 → 字典键；`null`（认不出的码）走 `unknown`。 */
export const PUBLISH_CHANNEL_STATUS_KEYS = {
  success: "log.channel_status.success",
  failed: "log.channel_status.failed",
  auditing: "log.channel_status.auditing",
  in_progress: "log.channel_status.in_progress",
  disabled: "log.channel_status.disabled",
  unknown: "log.channel_status.unknown",
} as const;

/** 平台侧发布动作的结果 → 字典键；认不出的结果由调用方回落成原始串（如实展示，不翻译成看似精确的结论）。 */
export const PUBLISH_ACTION_RESULT_KEYS: Record<string, string> = {
  ok: "log.action_result_ok",
  upstream_rejected: "log.action_result_upstream_rejected",
  upstream_unavailable: "log.action_result_upstream_unavailable",
  failed: "log.action_result_failed",
};

/** 发布时间上屏格式：跟随当前 locale（不得在共享组件里固定 `zh-CN`，§9.3）；无效时间串回落为 null。 */
export function formatPublishTime(iso: string | null, locale: string): string | null {
  if (iso === null) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString(locale);
}
