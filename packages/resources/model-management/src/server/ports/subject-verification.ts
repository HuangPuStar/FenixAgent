/**
 * 主体可用性判定的窄端口（决策 Q2 = A：宿主注入窄端口）。
 *
 * ## 它解决的是什么
 *
 * 给某个用户签发上游模型网关 Key 之前，必须回答"这个用户现在还能不能用这个 Agent"。这个判断需要
 * 三样东西：身份表（用户、组织、成员关系）、`agent_config` 资源行的归属、以及 agent_config 的**真实
 * 授权规则**（`use` 动作）。三样都在本包之外：身份与授权由 `@fenix/identity` / `@fenix/access-control`
 * 拥有，`agent_config` 的资源定义由 `@fenix/agent-config` 拥有。
 *
 * 因此本包不 import 它们中的任何一个，而是声明这个窄端口，由 `apps/server` 在装配时用真实的
 * `AccessControlModule` + `agentConfigResource.definition` + `IdentityDirectory` 实现。这样做的两个后果
 * 都是刻意的：
 *
 * 1. **规则只有一份**。上游凭据的可用性判定与平台其它入口的 agent_config 授权走同一个 `authorize`，
 *    不会再出现"这里放行、那里拒绝"两套真相。
 * 2. **不引入反向依赖**。`model-management` 不依赖 agent-config 的资源定义，也不依赖具体授权实现，
 *    依赖方向仍然是 `资源包 → platform-sdk`。
 *
 * ## 为什么不信任上游（不采用"信任调用方"的方案）
 *
 * 换 Key 的编排域在 `agent-runtime`，入口分散在多个包（`/api/agents/:id/instances/connect`、
 * Facade 的 restart、Environment 自动启动、`/api/agents/:id/v1/chat/completions`、workflow 节点、
 * 交互式 Chat 的 WS 连接、系统 Key 管理）。把"签发前必须复验"这条不变量复制到每个入口
 * 会增加新增入口时的遗漏风险；收敛到一个端口则漏不掉。
 *
 * ## 返回原因而不是布尔
 *
 * 凭据吊销检测需要区分"主体已不存在"与"权限被收回"：前者应删除上游凭据，后者应保留映射并等待权限
 * 恢复。布尔会把这两种处置压成一种。
 */

/** 主体复验的拒绝原因；取值与模型网关凭据的吊销原因一一对应。 */
export type SubjectRejectionReason =
  | "USER_NOT_FOUND"
  | "ORGANIZATION_NOT_FOUND"
  | "MEMBERSHIP_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "AGENT_ACCESS_REVOKED";

export type SubjectVerdict =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: SubjectRejectionReason };

export interface SubjectVerificationInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly agentConfigId: string;
}

/**
 * 主体复验端口；由宿主装配，实现必须走 `agent_config` 的真实授权路径。
 *
 * 输入里没有 actor：这个判断的 actor **就是**待复验的主体本人（`userId` + `organizationId`），
 * 实现需要自行用 `IdentityDirectory.listMemberships(userId)` 取**全量**成员关系来构造 `ActorContext`
 * ——actor 必须是一份完整的身份投影，而不是只带当前组织一项的裁剪版。
 */
export interface SubjectVerificationPort {
  verify(input: SubjectVerificationInput): Promise<SubjectVerdict>;
}

/**
 * 拒绝原因到对外错误文案的映射。
 *
 * `MEMBERSHIP_NOT_FOUND` 与 `AGENT_ACCESS_REVOKED` 两句沿用迁移前的原文（`runtime.ts` 的 `ensureSubject`），
 * 其余三种原先没有对应文案——迁移前那两处判定只检查成员关系与恒真的读权限，用户 / 组织 / Agent
 * 的存在性从未被真正验证过。
 */
export const SUBJECT_REJECTION_MESSAGES: Readonly<Record<SubjectRejectionReason, string>> = {
  USER_NOT_FOUND: "user not found",
  ORGANIZATION_NOT_FOUND: "organization not found",
  MEMBERSHIP_NOT_FOUND: "user is not a member of the requested organization",
  AGENT_NOT_FOUND: "agent not found",
  AGENT_ACCESS_REVOKED: "user cannot access the requested agent",
};
