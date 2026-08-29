import { describe, expect, test } from "bun:test";
import {
  createModelGatewayUsageMappingLister,
  type ListUsageCredentialMappingsInput,
} from "../services/model-gateway/usage-mapping-service";

describe("model gateway usage mapping lister", () => {
  // 用量查询必须只读取目标 Provider 的全部映射，不能混入其他 Provider 或被单批大小截断。
  test("forwards the provider scope and reads every cursor page", async () => {
    const inputs: ListUsageCredentialMappingsInput[] = [];
    const lister = createModelGatewayUsageMappingLister({
      batchSize: 2,
      listCredentials: async (input) => {
        inputs.push(input);
        if (!input.afterId) return [{ id: "credential-1" }, { id: "credential-2" }];
        if (input.afterId === "credential-2") return [{ id: "credential-3" }];
        return [];
      },
    });

    const rows = await lister.listMappings("gateway-current");

    expect(rows).toEqual([{ id: "credential-1" }, { id: "credential-2" }, { id: "credential-3" }]);
    expect(inputs).toEqual([
      { gatewayProviderId: "gateway-current", limit: 2, statuses: ["active", "blocked", "error"] },
      {
        gatewayProviderId: "gateway-current",
        afterId: "credential-2",
        limit: 2,
        statuses: ["active", "blocked", "error"],
      },
    ]);
  });
});
