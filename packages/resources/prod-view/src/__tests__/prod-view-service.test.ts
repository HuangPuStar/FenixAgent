// ProdView 服务层分支：错误码归属（NOT_FOUND / DISABLED / DELETE_FAILED）、组织隔离，以及加载端点
// 「视图记录 → 环境 → 持久实例」这条链的参数传递。
//
// 覆盖边界：本文件用链式替身覆盖服务分支与参数传递；环境的真实创建（Agent 配置可读性校验、workspace
// 路径、自动启动）属于 agent-runtime，由该包自己的用例覆盖，这里只断言本包交出去的那份参数。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeTestApplicationInfrastructure, resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import {
  deleteProdView,
  getProdView,
  listProdViews,
  loadProdView,
  type ProdViewActor,
  type ProdViewServiceDeps,
  setProdViewDeps,
  updateProdView,
} from "../server/services/prod-view";
import {
  AGENT_ID,
  collectColumnNames,
  collectParamValues,
  createProdViewDbStub,
  type ProdViewDbStub,
  prodViewRow,
} from "./prod-view-db-stub";

const ACTOR: ProdViewActor = { organizationId: "org-1", userId: "user-1" };

/** 装配 DB 替身（先登记句柄、再初始化基础设施：基础设施持有的是引用）。 */
function installDbStub(stub: ProdViewDbStub): void {
  resetAllStubs();
  stubDb(stub.db);
  initializeTestApplicationInfrastructure();
}

/** 记录参数的外部能力替身：环境 id 与实例 id 由入参派生，避免用例里出现与链路无关的常量。 */
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

describe("prod-view 服务分支", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  afterEach(() => {
    // 依赖替身是模块级状态，不复位会泄漏到下一条用例（症状是「单独跑通过、全量跑失败」）。
    setProdViewDeps(null);
    resetAllStubs();
  });

  // 列表按调用者组织查询：组织取自认证上下文而不是请求，断言绑定值落到 actor 的组织上。
  test("listProdViews 以调用者组织查询", async () => {
    const stub = createProdViewDbStub([prodViewRow({ organizationId: "org-1" })]);
    installDbStub(stub);

    const result = await listProdViews(ACTOR, { agentId: AGENT_ID });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    const clause = stub.whereClauses.at(-1);
    expect(collectColumnNames(clause)).toContain("organization_id");
    expect(collectParamValues(clause)).toContain("org-1");
  });

  // 详情不存在时返回 NOT_FOUND 错误码（路由据此映射 404），不得返回成功信封包一个 undefined。
  test("getProdView 无记录时返回 NOT_FOUND", async () => {
    installDbStub(createProdViewDbStub([]));

    const result = await getProdView(ACTOR, "pv-missing");

    expect(result).toEqual({ success: false, error: { code: "NOT_FOUND", message: "ProdView not found" } });
  });

  // 更新前先读一次：不存在的记录不应进入写路径（否则会在「记录不存在」时留下一次无谓的 UPDATE）。
  test("updateProdView 无记录时返回 NOT_FOUND 且不写库", async () => {
    const stub = createProdViewDbStub([]);
    installDbStub(stub);

    const result = await updateProdView(ACTOR, "pv-missing", { name: "新名" });

    expect(result).toEqual({ success: false, error: { code: "NOT_FOUND", message: "ProdView not found" } });
    expect(stub.writes.updates).toHaveLength(0);
  });

  // 删除前先读一次：不存在的记录返回 NOT_FOUND，而不是 DELETE_FAILED（两者的可观测语义不同）。
  test("deleteProdView 无记录时返回 NOT_FOUND", async () => {
    const stub = createProdViewDbStub([]);
    installDbStub(stub);

    const result = await deleteProdView(ACTOR, "pv-missing");

    expect(result).toEqual({ success: false, error: { code: "NOT_FOUND", message: "ProdView not found" } });
  });

  // 读到了行、删除却未命中（并发删除）时回 DELETE_FAILED，由路由映射为 404；不得报成功。
  test("deleteProdView 删除未命中时返回 DELETE_FAILED", async () => {
    const stub = createProdViewDbStub([prodViewRow({ id: "pv-1" })]);
    installDbStub(stub);
    stub.flags.deleteReturnsEmpty = true;

    const result = await deleteProdView(ACTOR, "pv-1");

    expect(result).toEqual({ success: false, error: { code: "DELETE_FAILED", message: "Failed to delete" } });
  });

  // 删除成功返回 `{ ok: true }`：调用方不需要行内容，返回整行会把已删除的记录重新交回前端。
  test("deleteProdView 成功时返回 ok 信封", async () => {
    installDbStub(createProdViewDbStub([prodViewRow({ id: "pv-1" })]));

    await expect(deleteProdView(ACTOR, "pv-1")).resolves.toEqual({ success: true, data: { ok: true } });
  });

  // 加载端点对不存在的视图返回 NOT_FOUND，且不得为此创建环境（否则每次探测都会留下环境与实例）。
  test("loadProdView 无记录时返回 NOT_FOUND 且不创建环境", async () => {
    installDbStub(createProdViewDbStub([]));
    const { envInputs } = installRecordingDeps();

    const result = await loadProdView(ACTOR, "pv-missing");

    expect(result).toEqual({ success: false, error: { code: "NOT_FOUND", message: "ProdView not found" } });
    expect(envInputs).toHaveLength(0);
  });

  // 停用的视图必须拒绝加载：这是「下线视图」的唯一可控手段，放行等于停用无效。
  test("loadProdView 视图停用时返回 DISABLED 且不创建环境", async () => {
    const stub = createProdViewDbStub([prodViewRow({ id: "pv-1", enabled: false })]);
    installDbStub(stub);
    const { envInputs } = installRecordingDeps();

    const result = await loadProdView(ACTOR, "pv-1");

    expect(result).toEqual({ success: false, error: { code: "DISABLED", message: "ProdView is disabled" } });
    expect(envInputs).toHaveLength(0);
  });

  // 加载成功：环境由视图绑定的 Agent 配置创建，身份取调用者本人，实例挂在刚创建的环境上，
  // 三者必须一一对应——错位会让访客连上别人的实例。
  test("loadProdView 串起 视图 → 环境 → 持久实例 的链路", async () => {
    const stub = createProdViewDbStub([
      prodViewRow({
        id: "pv-1",
        name: "发布视图",
        agentId: AGENT_ID,
        modulesConfig: { chatView: { enabled: false } },
      }),
    ]);
    installDbStub(stub);
    const { envInputs, instanceInputs } = installRecordingDeps();

    const result = await loadProdView(ACTOR, "pv-1");

    expect(result.success).toBe(true);
    if (!result.success) throw new Error("加载失败，后续断言无意义");
    const environmentId = `env-for-${AGENT_ID}`;
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
    expect(instanceInputs).toEqual([[environmentId, "user-1"]]);
    expect(result.data).toEqual({
      agentConfigId: AGENT_ID,
      environmentId,
      instanceUid: `inst-for-${environmentId}`,
      name: "发布视图",
      modulesConfig: { chatView: { enabled: false } },
    });
  });

  // 组织隔离：调用者组织与视图所属组织不同时，查询绑定值必须是调用者的组织（跨组织读不到他人视图）。
  test("loadProdView 以调用者组织定位记录", async () => {
    const stub = createProdViewDbStub([prodViewRow({ organizationId: "org-2", id: "pv-2" })]);
    installDbStub(stub);
    installRecordingDeps();

    await loadProdView({ organizationId: "org-2", userId: "user-2" }, "pv-2");

    const clause = stub.whereClauses.at(-1);
    expect(collectParamValues(clause)).toContain("org-2");
    expect(collectParamValues(clause)).not.toContain("org-1");
  });
});
