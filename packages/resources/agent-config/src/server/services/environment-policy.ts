import { ValidationError } from "@fenix/platform-sdk";
/** 根据策略与部署上限计算临时环境期限。 */
export function effectiveEnvironmentTtl(ttl: number | null, maximum: number): number {
  return Math.min(ttl ?? 3600, maximum);
}
/** 策略写入拒绝越界，不静默截断用户配置。 */
export function validateEnvironmentTtl(ttl: number, maximum: number): number {
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > maximum)
    throw new ValidationError(`ttlSeconds must be between 1 and ${maximum}`);
  return ttl;
}
let maximumTtl: (() => number) | undefined;
/** 宿主注入 Runtime owner 的部署上限，配置只有一处权威来源。 */
export function bindEnvironmentPolicyMaximum(read: () => number): void {
  maximumTtl = read;
}
/** 取得已装配的部署上限；装配遗漏不能静默绕过限制。 */
export function getEnvironmentPolicyMaximum(): number {
  if (!maximumTtl) throw new Error("Environment policy maximum is not bound");
  return maximumTtl();
}
