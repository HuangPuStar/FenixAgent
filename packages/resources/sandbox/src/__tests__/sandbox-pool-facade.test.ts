// 沙盒资源池 Facade 的职责断言：**把 actor 换成显式组织范围**，并保证「沙盒未启用」时一个池都不读。
//
// 与 `./sandbox-pool-route.test.ts`、`./sandbox-pool-config-api.test.ts` 的分工：那两条用例证明协议形状
// 与领域服务的裁剪口径，本文件证明**仓储收到的组织谓词确实来自 actor**——替身按收到的组织模拟
// `organization_id IS NULL OR organization_id = $1`，因此跨组织的私有池走不到调用方。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import type { SandboxPool } from "@fenix/resource-sandbox/db";
import { createSandboxPoolFacade } from "../server/facades/sandbox-pool-facade";
import { initializeSandboxModuleConfig } from "../server/testing";

const ACTOR = { organizationId: "org-1" } as const;

function pool(overrides: Partial<SandboxPool> = {}): SandboxPool {
  return {
    id: "default",
    name: "默认沙盒",
    organizationId: null,
    providerKey: "opensandbox-cluster",
    image: "private/image:latest",
    defaultResources: { cpu: 1 },
    extra: { secret: "must-not-leak" },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

/** 全局池 + org-1 私有池 + org-2 私有池：只有前两个对 org-1 可读。 */
const allPools = [
  pool(),
  pool({ id: "org-1-pool", name: "本组织池", organizationId: "org-1" }),
  pool({ id: "org-2-pool", name: "他人组织池", organizationId: "org-2" }),
];

/** 最近一次组织级读取收到的组织 ID：范围必须由 actor 的组织推导，而不是查询串。 */
let queriedOrganizationIds: string[] = [];

/**
 * 被测 Facade：注入模拟仓储组织谓词（`organization_id IS NULL OR organization_id = $1`）的读取替身，
 * 因此跨组织的私有池走不到调用方，同时记录收到的组织供断言。
 */
function facadeWithRecordingReader() {
  return createSandboxPoolFacade({
    listReadablePools: async (organizationId: string) => {
      queriedOrganizationIds.push(organizationId);
      return allPools.filter((item) => item.organizationId === null || item.organizationId === organizationId);
    },
  });
}

describe("Sandbox 资源池 Facade 的范围推导", () => {
  beforeEach(() => {
    queriedOrganizationIds = [];
  });

  // 复位应用基础设施：它只允许初始化一次，遗留的已初始化状态会让同进程后续用例的 DB 替身失去作用。
  afterEach(() => {
    resetAllStubs();
  });

  // 沙盒启用时：组织范围来自 actor，且只返回全局池与本组织池的轻量选项。
  test("listOptions 用 actor 的组织读取可读池", async () => {
    initializeSandboxModuleConfig({ sandboxEnabled: true });

    const options = await facadeWithRecordingReader().listOptions(ACTOR);

    expect(queriedOrganizationIds).toEqual(["org-1"]);
    expect(options).toEqual({
      enabled: true,
      pools: [
        { id: "default", name: "默认沙盒" },
        { id: "org-1-pool", name: "本组织池" },
      ],
    });
  });

  // 换一个组织必须换一批池：读到的集合随 actor 变化，说明范围没有被硬编码或跨组织复用。
  test("listOptions 对另一个组织只返回该组织可读的池", async () => {
    initializeSandboxModuleConfig({ sandboxEnabled: true });

    const options = await facadeWithRecordingReader().listOptions({ organizationId: "org-2" });

    expect(queriedOrganizationIds).toEqual(["org-2"]);
    expect(options.pools.map((item) => item.id)).toEqual(["default", "org-2-pool"]);
  });

  // 沙盒未启用时不得读资源池：空选项信封是状态判断的结果，不是查询结果。
  test("listOptions 在沙盒关闭时不读取资源池", async () => {
    initializeSandboxModuleConfig({ sandboxEnabled: false });

    await expect(facadeWithRecordingReader().listOptions(ACTOR)).resolves.toEqual({ enabled: false, pools: [] });
    expect(queriedOrganizationIds).toEqual([]);
  });
});
