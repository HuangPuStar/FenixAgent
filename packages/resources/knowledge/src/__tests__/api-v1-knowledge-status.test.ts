import { afterEach, expect, test } from "bun:test";
import { checkApiKnowledgeStatus } from "../server/services/api-v1-knowledge";
import type { KnowledgeBaseListItem } from "../server/services/knowledge-base";
import { setKnowledgeProviderForTesting } from "../server/services/knowledge-provider/registry";
import type { KnowledgeProvider } from "../server/services/knowledge-provider/types";

afterEach(() => setKnowledgeProviderForTesting(null));
// 远端缺失与网络失败不同，未知不能伪装成 false 或 ready。
test("v1 KB distinguishes exists, missing and unavailable without mutating local state", async () => {
  setKnowledgeProviderForTesting({
    getDataset: async ({ datasetId }) => {
      if (datasetId === "offline") throw new Error("offline");
      return datasetId === "missing" ? null : {};
    },
  } as KnowledgeProvider);
  const rows = ["exists", "missing", "offline"].map(
    (id) =>
      ({
        id,
        remoteId: id,
        organizationId: "org",
        userId: "user",
        status: "ready",
        name: id,
        description: null,
        provider: "ragflow",
        resourcesCount: 1,
        bindingsCount: 2,
        remoteExists: true,
      }) as KnowledgeBaseListItem,
  );
  const result = await checkApiKnowledgeStatus(rows, undefined, async () => "fixture");
  expect(result.map((row) => row.remoteExists)).toEqual([true, false, null]);
  expect(rows.map((row) => row.remoteExists)).toEqual([true, true, true]);
  expect(result.map((row) => row.status)).toEqual(["ready", "ready", "ready"]);
  for (const row of result) {
    expect(row).not.toHaveProperty("remoteId");
    expect(row).not.toHaveProperty("userId");
  }
});
