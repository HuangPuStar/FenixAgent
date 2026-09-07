import type { ModuleManifest } from "@fenix-ce/platform-sdk";
import { EnterpriseAccessControl } from "@fenix-ee/access-control";

/** EE 整体替换身份与授权模型的模块声明。 */
export const moduleManifest = {
  id: "enterprise",
  kind: "access-control",
  dependsOn: [],
  envDefinitions: [{ moduleId: "enterprise-access-control", key: "CUSTOMER_SSO_ISSUER" }],
  create: () => new EnterpriseAccessControl(),
} satisfies ModuleManifest;
