/**
 * 发布版本的**号段算术**：解析与自增（`vx.y.z`）。
 *
 * 版本号格式与步长的依据（**不是猜测**，全部来自关联上游工作流引擎仓的权威源码）：
 * - thrift 生成物 `PublishWorkflowRequest.WorkflowVersion` 的注释写明：「Required, the version number of
 *   the published workflow, in **SemVer format "vx.y.z"**, must be larger than the current version」；
 * - 服务端 `parseVersion`（`backend/domain/workflow/service/utils.go`）只接受「`v` 前缀 + 恰好三段整数」，
 *   否则返回 `ErrInvalidVersionName = 777777769`；`isIncremental` 要求新版本在 (major, minor, patch) 上
 *   **严格大于**已发布版本，否则 `777777775 the version number is not self-incrementing`；
 * - 首次发布用什么版本、后续怎么加：上游自己的发布对话框
 *   （`frontend/packages/workflow/playground/.../publish-with-version-v2.tsx` 的 `getDefaultVersion`）
 *   给的是 `workflow_version ? 'v' + semver.inc(version, 'patch') : 'v0.0.1'`——即**首发布 v0.0.1、其后
 *   patch 自增**。本模块照此口径生成，与上游控制台的行为一致（用户在两处看到的版本号序列相同）。
 *
 * 版本自增的基准**只来自上游**（调用方经 `upstreamPublishedVersion` 传入，读路径见
 * `workflow-publish-state.ts`）：契约快照 F3 实测「`workflow_detail.version` 在发布前后均为空串」，而
 * `workflow_detail_info` 的 `latest_flow_version` 与 canvas 的 `workflow_version` 同源（上游
 * `wf.LatestPublishedVersion`），是唯一可用的当前版本来源。
 *
 * 控制台发布入口已于 2026-10-10 撤除（发布动作在上游侧完成，见 `docs/arch/25-workflow-v2.md`）；本模块的
 * 消费者只剩对外触发链路的 `api-channel-release.ts`——它的运行前自愈需要一个「严格大于当前版本」的新版本号。
 */

/** 首次发布的初始版本：与上游控制台 `getDefaultVersion` 的 `v0.0.1` 同口径（见文件头）。 */
export const INITIAL_PUBLISH_VERSION = "v0.0.1";

/** 版本形状：`v` + 三段整数（上游 `parseVersion` 的唯一接受形状）。 */
const PUBLISH_VERSION_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;

export interface WorkflowVersionParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** 解析 `vx.y.z`；不合法返回 null（调用方据此拒绝自增，而不是猜一个版本号送上去）。 */
export function parsePublishVersion(version: string): WorkflowVersionParts | null {
  const matched = PUBLISH_VERSION_PATTERN.exec(version.trim());
  if (matched === null) return null;
  return { major: Number(matched[1]), minor: Number(matched[2]), patch: Number(matched[3]) };
}

/**
 * 下一个发布版本：上游无发布版本（null）取 {@link INITIAL_PUBLISH_VERSION}，否则同 major.minor 下 patch+1。
 *
 * 上游版本不可解析时返回 null——上游自己写入的版本恒为 `vx.y.z`，解析不出说明读到的不是版本号（上游行为
 * 变化或响应被截断），此时**拒绝自增**（调用方不发布），不拿一个伪造的版本号去撞上游（撞上就是 777777775，
 * 错误信息还指向版本号，掩盖真因）。
 */
export function nextPublishVersion(upstreamPublishedVersion: string | null): string | null {
  if (upstreamPublishedVersion === null) return INITIAL_PUBLISH_VERSION;
  const current = parsePublishVersion(upstreamPublishedVersion);
  if (current === null) return null;
  return `v${current.major}.${current.minor}.${current.patch + 1}`;
}
