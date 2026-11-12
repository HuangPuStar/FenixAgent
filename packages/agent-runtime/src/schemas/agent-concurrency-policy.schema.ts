import * as z from "zod/v4";

/** null 继承，非空上限须能落入 PostgreSQL integer。 */
export const ConcurrencyLimitSchema = z.number().int().positive().max(2147483647).nullable();
/** 平台部分更新契约。 */
export const ConcurrencyPatchSchema = z
  .object({
    agentMaxConcurrency: ConcurrencyLimitSchema.optional(),
    userAgentMaxConcurrency: ConcurrencyLimitSchema.optional(),
    scheduledAgentMaxConcurrency: ConcurrencyLimitSchema.optional(),
  })
  .strict();
/** 单项的显式覆盖、有效值及继承来源。 */
export const ConcurrencySettingSchema = z.object({
  override: ConcurrencyLimitSchema,
  value: ConcurrencyLimitSchema,
  defaultValue: ConcurrencyLimitSchema,
  source: z.enum(["environment", "global", "user"]),
});
/** 管理端三项设置。 */
export const ConcurrencyPolicyViewSchema = z.object({
  agentMaxConcurrency: ConcurrencySettingSchema,
  userAgentMaxConcurrency: ConcurrencySettingSchema,
  scheduledAgentMaxConcurrency: ConcurrencySettingSchema,
});
/** 用户限额及最小身份显示投影。 */
export const UserConcurrencyPolicySchema = z.object({
  userId: z.string(),
  name: z.string(),
  policy: ConcurrencyPolicyViewSchema,
});
/** 指定用户只允许设置每用户限额。 */
export const UserConcurrencyPutSchema = z.object({ userAgentMaxConcurrency: ConcurrencyLimitSchema }).strict();
