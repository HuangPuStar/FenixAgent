import { describe, expect, test } from "bun:test";
import { modelGatewayCredential, provider } from "../db/schema";

describe("model gateway persistence schema", () => {
  // 验证 Provider 类型通过正式字段表达，避免运行时依赖 extra_options 猜测网关。
  test("exposes provider kind and gateway type columns", () => {
    expect(provider.kind).toBeDefined();
    expect(provider.gatewayType).toBeDefined();
  });

  // 验证 Credential Mapping 保留业务归属、加密凭证和可扩展 metadata。
  test("exposes credential mapping columns without subject foreign keys", () => {
    expect(modelGatewayCredential.gatewayProviderId).toBeDefined();
    expect(modelGatewayCredential.organizationId).toBeDefined();
    expect(modelGatewayCredential.userId).toBeDefined();
    expect(modelGatewayCredential.agentConfigId).toBeDefined();
    expect(modelGatewayCredential.externalCredentialId).toBeDefined();
    expect(modelGatewayCredential.encryptedCredential).toBeDefined();
    expect(modelGatewayCredential.status).toBeDefined();
    expect(modelGatewayCredential.metadata).toBeDefined();
  });
});
