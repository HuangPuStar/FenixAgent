/**
 * 宿主认证结果在本包的最小投影（1.4 W2 起由本包自持，不再从 `@server/plugins/auth` 取类型）。
 *
 * 为什么是最小结构类型：本包的消费点只做两类判断——「请求是否已认证」与「环境归属的组织 / 用户是否与
 * 请求方一致」（`external-relay` 的归属校验、`api-instance` 的按用户建环境、`routes/acp` 的 YJS 端点
 * 归属校验）。宿主的 `AuthContext` 另外携带 `role` 与全量 `memberships`，那是宿主授权面的输入：本包
 * 既不解释也不该依赖，否则宿主授权模型的任何调整都会变成对 runtime 的编译期破坏。
 *
 * 兼容方向：宿主把它的完整 `AuthContext`（结构超集）传进来天然兼容；反向不成立，本包不得把这里的
 * 类型当作宿主授权输入回传。
 */

/** 认证上下文的最小投影：归属组织 + 用户。 */
export interface AuthContext {
  readonly organizationId: string;
  readonly userId: string;
}

/** 宿主 `authenticateRequest()` 的返回投影：本包只消费 `user.id` 与 `authContext`。 */
export interface RequestAuthResult {
  readonly user: { readonly id: string };
  readonly authContext: AuthContext | null;
}
