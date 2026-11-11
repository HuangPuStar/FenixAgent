import { request, unwrap } from "@fenix/web-runtime/api/request";
import { getAdminKey } from "@fenix/web-runtime/lib/admin-key";

/** 管理 API 的实际值与来源；null 实际值表示不限。 */
export interface ConcurrencySetting {
  override: number | null;
  value: number | null;
  source: "environment" | "global" | "user";
}
/** 平台三项并发设置。 */
export interface ConcurrencyPolicyView {
  agentMaxConcurrency: ConcurrencySetting;
  userAgentMaxConcurrency: ConcurrencySetting;
  scheduledAgentMaxConcurrency: ConcurrencySetting;
}
/** 用户覆盖列表及详情契约。 */
export interface UserConcurrencyPolicy {
  userId: string;
  name: string;
  policy: ConcurrencyPolicyView;
}
/** null 恢复继承的全局部分更新。 */
export type ConcurrencyPatch = Partial<Record<keyof ConcurrencyPolicyView, number | null>>;
const base = "/api/system/agent-concurrency";
const auth = () => ({ bearerToken: getAdminKey() ?? undefined });

/** 系统密钥并发策略 client；全部使用标准 request/unwrap 错误语义。 */
export const agentConcurrencyApi = {
  getGlobal: () => unwrap(request<ConcurrencyPolicyView>(base, auth())),
  patchGlobal: (body: ConcurrencyPatch) =>
    unwrap(request<ConcurrencyPolicyView>(base, { ...auth(), method: "PATCH", body })),
  listUsers: () => unwrap(request<UserConcurrencyPolicy[]>(`${base}/users`, auth())),
  getUser: (userId: string) =>
    unwrap(request<UserConcurrencyPolicy>(`${base}/users/:userId`, { ...auth(), params: { userId } })),
  putUser: (userId: string, userAgentMaxConcurrency: number | null) =>
    unwrap(
      request<UserConcurrencyPolicy>(`${base}/users/:userId`, {
        ...auth(),
        method: "PUT",
        params: { userId },
        body: { userAgentMaxConcurrency },
      }),
    ),
  deleteUser: (userId: string) =>
    unwrap(
      request<UserConcurrencyPolicy>(`${base}/users/:userId`, { ...auth(), method: "DELETE", params: { userId } }),
    ),
};
