import type { EnvDefinition } from "../../../../ce/apps/server/src/env";

/** EE 只追加自己的部署配置；不改写 CE 同名变量。 */
export const enterpriseAccessControlEnv: readonly EnvDefinition[] = [
  { moduleId: "enterprise-access-control", key: "CUSTOMER_SSO_ISSUER" },
];
