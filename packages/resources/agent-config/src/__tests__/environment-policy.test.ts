import { expect, test } from "bun:test";
import { effectiveEnvironmentTtl, validateEnvironmentTtl } from "../server/services/environment-policy";

// 未配置策略使用一小时，并由部署上限截断。
test("environment TTL defaults to 3600 and respects the deployment maximum", () => {
  expect(effectiveEnvironmentTtl(null, 86400)).toBe(3600);
  expect(effectiveEnvironmentTtl(null, 600)).toBe(600);
  expect(effectiveEnvironmentTtl(7200, 3600)).toBe(3600);
});
// 写入非法配置必须拒绝，而不是静默截断已提交值。
test("environment TTL rejects non-positive and out of range policy writes", () => {
  for (const value of [0, -1, 1.5, 86401]) expect(() => validateEnvironmentTtl(value, 86400)).toThrow();
  expect(validateEnvironmentTtl(86400, 86400)).toBe(86400);
});
