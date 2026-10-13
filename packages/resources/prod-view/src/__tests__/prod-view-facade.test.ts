// ProdView Facade 的职责断言：**把 actor 换成显式范围**，并把公开读取端点的校验口径钉在同一处。
//
// 与 ./prod-view-service.test.ts 的分工：服务层用例证明「拿到某个组织/用户后做的事对不对」，本文件证明
// 「交给服务与仓储的那个组织/用户确实来自 actor」。替身不做行过滤（见 ./prod-view-db-stub 的说明），
// 因此这里钉的是**交给数据库的组织谓词**与**交给 agent-runtime 的归属**，而不是替身自己实现的过滤结果。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeTestApplicationInfrastructure, resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { prodViewFacade } from "../server/facades/prod-view-facade";
import { type ProdViewServiceDeps, setProdViewDeps } from "../server/services/prod-view";
import {
  AGENT_ID,
  collectColumnNames,
  collectParamValues,
  createProdViewDbStub,
  type ProdViewDbStub,
  prodViewRow,
} from "./prod-view-db-stub";

/** 认证守卫会写入 `store.authContext` 的形状；Facade 只消费其中两个字段。 */
const ACTOR = { organizationId: "org-1", userId: "user-1" } as const;

/** 装配 DB 替身（先登记句柄、再初始化基础设施：基础设施持有的是引用）。 */
function installDbStub(stub: ProdViewDbStub): void {
  resetAllStubs();
  stubDb(stub.db);
  initializeTestApplicationInfrastructure();
}

/** 记录加载端点交出去的外部能力入参；id 由入参派生，便于与断言里的期望值对齐。 */
function installRecordingDeps(): {
  envInputs: Array<Parameters<ProdViewServiceDeps["createWebEnvironment"]>[0]>;
  instanceInputs: Array<Parameters<ProdViewServiceDeps["findOrCreateDefaultInstance"]>>;
} {
  const envInputs: Array<Parameters<ProdViewServiceDeps["createWebEnvironment"]>[0]> = [];
  const instanceInputs: Array<Parameters<ProdViewServiceDeps["findOrCreateDefaultInstance"]>> = [];
  setProdViewDeps({
    createWebEnvironment: async (params) => {
      envInputs.push(params);
      return { id: `env-for-${params.agentConfigId}` };
    },
    findOrCreateDefaultInstance: async (environmentId, ownerUserId) => {
      instanceInputs.push([environmentId, ownerUserId]);
      return { id: `inst-for-${environmentId}` };
    },
  });
  return { envInputs, instanceInputs };
}

describe("ProdView Facade 的范围推导", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  afterEach(() => {
    // 依赖替身是模块级状态，不复位会泄漏到下一条用例（症状是「单独跑通过、全量跑失败」）。
    setProdViewDeps(null);
    resetAllStubs();
  });

  // 读路径：列表的组织谓词必须是 actor 的当前组织，而不是请求参数或其它来源——这是跨组织隔离的唯一出处。
  test("list 把 actor 的组织下推为查询谓词", async () => {
    const stub = createProdViewDbStub([prodViewRow({ organizationId: "org-1" })]);
    installDbStub(stub);

    const result = await prodViewFacade.list(ACTOR, { agentId: AGENT_ID });

    expect(result.success).toBe(true);
    const clause = stub.whereClauses.at(-1);
    expect(collectColumnNames(clause)).toContain("organization_id");
    expect(collectParamValues(clause)).toContain("org-1");
    expect(collectParamValues(clause)).not.toContain("org-2");
  });

  // 写路径：组织与创建者只能来自 actor，任何请求数据都不得改变归属（否则可把视图写进他人组织）。
  test("create 用 actor 的组织与用户落成归属", async () => {
    const stub = createProdViewDbStub([]);
    installDbStub(stub);

    const result = await prodViewFacade.create(ACTOR, { name: "新视图", agentId: AGENT_ID });

    expect(result.success).toBe(true);
    expect(stub.writes.inserts).toHaveLength(1);
    expect(stub.writes.inserts[0]).toMatchObject({
      organizationId: "org-1",
      createdBy: "user-1",
      agentId: AGENT_ID,
    });
  });

  // 加载路径：记录用 actor 的组织定位，环境与持久实例按 actor 本人创建——访客不该连上他人的实例。
  test("load 的组织谓词与环境/实例归属都取自 actor", async () => {
    const stub = createProdViewDbStub([
      prodViewRow({ id: "pv-2", organizationId: "org-2", agentId: AGENT_ID, enabled: true }),
    ]);
    installDbStub(stub);
    const { envInputs, instanceInputs } = installRecordingDeps();

    await prodViewFacade.load(ACTOR, "pv-2");

    const clause = stub.whereClauses.at(-1);
    expect(collectParamValues(clause)).toContain("org-1");
    expect(collectParamValues(clause)).not.toContain("org-2");
    expect(envInputs).toEqual([
      {
        name: `env-${AGENT_ID.slice(0, 8)}`,
        description: undefined,
        agentConfigId: AGENT_ID,
        autoStart: true,
        userId: "user-1",
        organizationId: "org-1",
      },
    ]);
    expect(instanceInputs).toEqual([[`env-for-${AGENT_ID}`, "user-1"]]);
  });
});
