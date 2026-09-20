/**
 * 用户 Agent 偏好的窄端口（`/web/config/agents` 的「默认 Agent」）。
 *
 * 为什么是端口而不是包内实现：偏好存在宿主的 `user_config` 表里，而该表是**身份族**表
 * （CLAUDE.md「数据库与迁移」：身份表真相来源是 `packages/platform/identity/db/schema.ts`），不归本包。
 * 资源包直接读它既违反表归属，也会绕开身份侧对偏好行的唯一写入路径。迁移前这两次读写经
 * `@server/services/config/user-config` 深链取得，属于 1.3 要切断的宿主内部依赖，因此改为由宿主在
 * 装配阶段注入一个 adapter（`getUserConfig` / `setUserConfig` 的薄封装）——与 model-management 的
 * `UserModelPreferencesPort` 同一形状，同一张表只留一组端口语义。
 *
 * 类型只描述本包真正读写的一个字段：`user_config` 其余列（模型偏好、权限）各有 owner，在这里展开
 * 会让本包对同一行的其它语义产生耦合。
 */

/** 偏好的定位主体：`user_config` 按组织一行存储，只需组织与用户标识。 */
export interface UserAgentPreferencesSubject {
  readonly organizationId: string;
  readonly userId: string;
}

/** 当前偏好的读值；未设置时为 `null`（与宿主 `getUserConfig` 的语义一致）。 */
export interface UserAgentPreferencesSnapshot {
  readonly defaultAgent: string | null;
}

/**
 * 偏好写入的补丁。
 *
 * 「未提供」与「显式置空」是两种语义：`undefined` 表示不改这一项，`null` 表示清空。宿主实现必须据此
 * 区分（`user-config.ts` 用 `!== undefined` 判定），否则只改默认 Agent 的请求会顺带抹掉模型偏好。
 */
export interface UserAgentPreferencesPatch {
  readonly defaultAgent?: string | null;
}

/** 用户 Agent 偏好的读写端口；由宿主装配注入，包内不提供默认实现。 */
export interface UserAgentPreferencesPort {
  read(subject: UserAgentPreferencesSubject): Promise<UserAgentPreferencesSnapshot>;
  write(subject: UserAgentPreferencesSubject, patch: UserAgentPreferencesPatch): Promise<void>;
}
