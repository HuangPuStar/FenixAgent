import { afterEach, describe, expect, test } from "bun:test";
import { _resetDeps, canReadResource, setResourcePermissionRepoForTesting } from "@fenix/access-control/server";
import type { IResourcePermissionRepo } from "../repositories/resource-permission";

afterEach(_resetDeps);

describe("round64 resource-permission repository", () => {
  // 服务仓储端口必须把跨组织读取参数完整传递给宿主持久化实现。
  test("forwards external read identity to the configured persistence port", async () => {
    let received: readonly string[] = [];
    setResourcePermissionRepoForTesting({
      canReadExternalResource: async (...args) => {
        received = args;
        return true;
      },
    } as IResourcePermissionRepo);

    await expect(
      canReadResource(
        { organizationId: "org-reader", userId: "user-1", role: "member" },
        "skill",
        "skill-1",
        "org-owner",
      ),
    ).resolves.toBe(true);
    expect(received).toEqual(["org-owner", "skill", "skill-1", "org-reader"]);
  });
});
