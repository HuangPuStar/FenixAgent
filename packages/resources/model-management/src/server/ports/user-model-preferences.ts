/**
 * 用户模型偏好的窄端口（`/web/config/models` 的当前模型 / 轻量模型 / 权限配置）。
 *
 * 为什么是端口而不是包内实现：偏好存在宿主的 `user_config` 表里，而该表是**身份族**表
 * （CLAUDE.md「数据库与迁移」：身份表真相来源是 `packages/platform/identity/db/schema.ts`），不归本包。
 * 资源包直接读它既违反表归属，也会跨包直连别人的数据。迁移前这两次读写经
 * `@server/services/config/user-config` 深链取得，属于 1.3 要切断的宿主内部依赖，因此改为由宿主在
 * 装配阶段注入一个 adapter（`getUserConfig` / `setUserConfig` 的薄封装）。
 *
 * 类型刻意只描述本包真正读写的三个字段，并且 `permission` 取 `unknown`：偏好里的权限对象是宿主权限栈
 * 的模型，本包只做透传与回显（`/web` 的响应 schema 也是 `z.unknown()`），收窄成具体类型会把宿主的
 * 领域模型拖进资源包的编译面。
 */

/** 偏好的定位主体：`user_config` 按组织一行存储，只需组织与用户标识。 */
export interface UserModelPreferencesSubject {
  readonly organizationId: string;
  readonly userId: string;
}

/** 当前偏好的读值；三个字段在「未设置」时都是 `null`（与宿主 `getUserConfig` 的语义一致）。 */
export interface UserModelPreferencesSnapshot {
  readonly currentModel: string | null;
  readonly smallModel: string | null;
  readonly permission: unknown;
}

/**
 * 偏好写入的补丁。
 *
 * 「未提供」与「显式置空」是两种语义：`undefined` 表示不改这一项，`null` 表示清空。宿主实现必须据此
 * 区分（`user-config.ts` 用 `!== undefined` 判定），否则一次只改主模型的请求会把权限配置一并抹掉。
 */
export interface UserModelPreferencesPatch {
  readonly currentModel?: string | null;
  readonly smallModel?: string | null;
  readonly permission?: unknown;
}

/** 用户模型偏好的读写端口；由宿主装配注入，包内不提供默认实现。 */
export interface UserModelPreferencesPort {
  read(subject: UserModelPreferencesSubject): Promise<UserModelPreferencesSnapshot>;
  write(subject: UserModelPreferencesSubject, patch: UserModelPreferencesPatch): Promise<void>;
}
