import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ActorContext, ResourceScopeStore } from "@fenix/platform-sdk";
import { AppError, ForbiddenError, NotFoundError } from "@fenix/platform-sdk";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { pluginPackageResource } from "../server/access/plugin-package-resource";
import type { PackageDetailView, PackageView } from "../server/domain/package-view";
import { parsePackageSnapshot } from "../server/domain/snapshot";
import {
  PluginPackageFacade,
  type PluginRegistryPort,
  PreviewChangedError,
} from "../server/facades/plugin-package-facade";
import type { PackageVersionRef, PublicationPreview } from "../server/npm-registry/types";
import {
  createMemoryCatalog,
  createMemoryCatalogPort,
  digestOf,
  snapshotJsonOf,
  TEST_PACKAGE_NAME,
} from "./catalog-harness";
import {
  createFakeAccessControl,
  createRecordingPackageService,
  createStubIdentity,
  memberActor,
  outsiderActor,
  packageDetailViewOf,
  packageViewOf,
  resetMarketModuleStub,
  SYSTEM_TENANT,
  systemAdminActor,
} from "./market-fixtures";

/**
 * 市场 Facade 的契约测试。
 *
 * 这个文件锁定的三件事都无法从读代码确认：
 *
 * 1. **哪些路径永不出网**。幂等（版本已可见）与恢复（版本已下架）必须复用市场内的冻结快照——预览与确认之间
 *    私有源上的内容可能已被替换，而恢复的语义是「把市场里那一份重新对公众可见」。私有源读取做成可计数的端口，
 *    于是「没出网」是一条断言而不是一句注释。
 * 2. **摘要比对是确认步骤的全部意义**。不一致时写入必须被拦下，并把新快照交回前端原地重新确认。
 * 3. **读口径由写权推出**。写权主体看得到整包下架的条目，其余人只看公开面；两类主体共用读侧的同一条可见性
 *    谓词，因此「列表里有、详情却 404」不可能出现。
 *
 * 目录状态由 `./catalog-harness` 的内存底座驱动**生产**的规则函数（分派结果因此是在真实状态迁移上验证的），
 * 授权由 `./market-fixtures` 的策略同形替身给出。测试进程里没有 Postgres，也没有应该被访问的私有源。
 */

const VERSION = "1.0.0";

/** 断言调用以某个错误失败，并返回该错误以便进一步断言细节。 */
const errorOf = async (work: Promise<unknown>): Promise<AppError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
};

const codeOf = async (work: Promise<unknown>): Promise<string> => (await errorOf(work)).code;

/** 模块配置：本文件不触碰私有源，地址与凭据都留空，只有 sourceId 是读路径需要的。 */
const configWith = (overrides: Record<string, unknown> = {}) => ({
  sourceId: "npm",
  registryUrl: null,
  registryToken: null,
  registryTimeoutMs: 8000,
  registryMaxBytes: 4194304,
  ...overrides,
});

/**
 * 无用但必须存在的 scope store。
 *
 * 本 Facade 的路径都不改 `visibility`（市场条目恒为 public，`access/plugin-package-resource.ts` 说明了原因），
 * 基类持有它只是为了满足资源 Facade 的统一装配形状。
 */
const scopeStore: ResourceScopeStore = {
  initialize: async () => undefined,
  getMany: async () => new Map(),
  update: async () => undefined,
  remove: async () => undefined,
};

/** 一次预览结果夹具；摘要由用例给定，供比对用例分别控制一致与不一致两种情况。 */
function previewOf(version: string, metadataDigest: string): PublicationPreview {
  const metadataJson = snapshotJsonOf(version);
  const metadata = parsePackageSnapshot(metadataJson);
  if (!metadata) throw new Error("夹具快照必须能被解析");
  return {
    ref: { sourceId: "npm", packageName: TEST_PACKAGE_NAME, exactVersion: version },
    metadata,
    metadataJson,
    metadataDigest,
  };
}

/** 装配一个用例所需的全部世界；返回值里的记录器就是断言点。 */
function setup(
  input: {
    readonly preview?: PublicationPreview;
    readonly items?: readonly PackageView[];
    readonly detail?: PackageDetailView;
  } = {},
) {
  const catalog = createMemoryCatalog();
  const catalogPort = createMemoryCatalogPort(catalog);
  const { service, listCalls, detailCalls } = createRecordingPackageService({
    items: input.items ?? [],
    detail: input.detail ?? null,
  });
  const { identity, tenantReads } = createStubIdentity();
  const registryCalls: PackageVersionRef[] = [];
  const preview = input.preview ?? previewOf(VERSION, "sha256:preview");
  const registry: PluginRegistryPort = {
    async preview(ref) {
      registryCalls.push(ref);
      return preview;
    },
  };
  const facade = new PluginPackageFacade(service, {
    accessControl: createFakeAccessControl(),
    resource: pluginPackageResource.definition,
    scopeStore,
    identity,
    catalog: catalogPort.port,
    registry,
  });
  return { facade, catalog, catalogPort, listCalls, detailCalls, tenantReads, registryCalls, preview };
}

beforeEach(() => {
  resetAllStubs();
  resetMarketModuleStub();
  initializeTestApplicationInfrastructure({ moduleConfigs: { "plugin-market": configWith() } });
});

afterEach(() => {
  resetMarketModuleStub();
});

describe("读口径", () => {
  // 写权主体看得到整包下架的条目，其余人只看公开面：口径由授权结果推出，读侧不做第二次判断。
  test("写权主体走 all 口径，普通成员走 public 口径", async () => {
    const world = setup();

    await world.facade.list(systemAdminActor());
    await world.facade.list(memberActor());

    expect(world.listCalls.map((call) => call.scope)).toEqual(["all", "public"]);
    // 来源标识只由部署配置决定，绝不接受请求传入。
    expect(world.listCalls.map((call) => call.sourceId)).toEqual(["npm", "npm"]);
  });

  // 页面级能力位与写权同源：管理员的空市场也要能拿到「可以发布」，否则第一次发布没有入口。
  test("空市场的 canPublish 仍按写权给出", async () => {
    const world = setup({ items: [] });

    const adminList = await world.facade.list(systemAdminActor());
    const outsiderList = await world.facade.list(outsiderActor());

    expect(adminList.total).toBe(0);
    expect(adminList.canPublish).toBe(true);
    expect(outsiderList.canPublish).toBe(false);
  });

  // 列表项必须带当前主体自己的有效动作：前端按 `access.actions` 决定是否显示发布/下架入口。
  test("列表项带主体自己的有效动作", async () => {
    const world = setup({ items: [packageViewOf()] });

    const adminList = await world.facade.list(systemAdminActor());
    const memberList = await world.facade.list(memberActor());

    expect(adminList.items[0]?.access.actions).toContain("create");
    expect(memberList.items[0]?.access.actions).toEqual(["read"]);
    expect(adminList.total).toBe(1);
  });

  // 详情按 slug 定位，并把主体的有效动作一并返回（与列表同形，前端两条路径共用一套判断）。
  test("详情按 slug 定位并附带有效动作", async () => {
    const detail = packageDetailViewOf();
    const world = setup({ detail });

    const view = await world.facade.getDetail(systemAdminActor(), detail.slug);

    expect(world.detailCalls[0]?.slug).toBe(detail.slug);
    expect(world.detailCalls[0]?.scope).toBe("all");
    expect(view.access.actions).toContain("create");
  });

  // 不存在、slug 非法与「整包下架且主体无写权」合流成同一个 404：区分它们会把市场变成内部状态探针。
  test("读侧返回空时统一映射为 404", async () => {
    const world = setup();

    expect(await errorOf(world.facade.getDetail(memberActor(), "absent"))).toBeInstanceOf(NotFoundError);
  });
});

describe("写权", () => {
  // 普通成员与外部组织的 owner 都不是写权主体：发布、下架、恢复、预览四条写路径全部 403，且此时私有源与目录
  // 一次都不该被触碰——未授权的主体连「代为读取私有源」都不应该发生。
  test("非系统管理员的四条写路径全部 403 且不出网", async () => {
    const write = { packageName: TEST_PACKAGE_NAME, exactVersion: VERSION, requestId: "req-1" };

    for (const actor of [memberActor(), outsiderActor()] as ActorContext[]) {
      const world = setup();

      for (const work of [
        world.facade.preview(actor, write),
        world.facade.publish(actor, { ...write, previewDigest: "sha256:preview" }),
        world.facade.unpublish(actor, write),
        world.facade.restore(actor, write),
      ]) {
        const error = await errorOf(work);
        expect(error).toBeInstanceOf(ForbiddenError);
        expect(error.code).toBe("FORBIDDEN");
        expect(error.statusCode).toBe(403);
      }

      expect(world.registryCalls).toEqual([]);
      expect(world.catalogPort.publishes).toEqual([]);
      expect(world.catalogPort.unpublishes).toEqual([]);
      expect(world.catalogPort.stateReads).toEqual([]);
    }
  });

  // 写权探测用的是「在系统租户下能否创建」这条与真实写入同源的判定；归属组织必须是系统托管租户，否则同一份
  // 全局目录会被切散到各管理员自己的组织下。
  test("系统管理员的发布归属固定为系统托管租户", async () => {
    const world = setup();

    await world.facade.publish(systemAdminActor(), {
      packageName: TEST_PACKAGE_NAME,
      exactVersion: VERSION,
      previewDigest: "sha256:preview",
      requestId: "req-2",
    });

    expect(world.catalogPort.publishes[0]?.creationScope.organizationId).toBe(SYSTEM_TENANT.organizationId);
    expect(world.catalogPort.publishes[0]?.operatorUserId).toBe(systemAdminActor().userId);
  });
});

describe("发布分派", () => {
  // 已可见版本必须严格幂等：不出网、不比对摘要，写入用的是市场内冻结的那一份快照。
  test("已可见版本幂等且复用库内快照", async () => {
    const world = setup();
    await world.catalog.publish(VERSION);

    const change = await world.facade.publish(systemAdminActor(), {
      packageName: TEST_PACKAGE_NAME,
      exactVersion: VERSION,
      // 摘要与库内快照的不一致，但幂等分支根本不该看它。
      previewDigest: "sha256:stale",
      requestId: "req-3",
    });

    expect(change.action).toBe("noop");
    expect(world.registryCalls).toEqual([]);
    expect(world.catalogPort.publishes).toHaveLength(1);
    expect(world.catalogPort.publishes[0]?.metadataJson).toBe(snapshotJsonOf(VERSION));
    expect(world.catalogPort.publishes[0]?.metadataDigest).toBe(digestOf(VERSION));
    expect(world.catalogPort.publishes[0]?.requestId).toBe("req-3");
  });

  // 已下架版本走恢复分支：同样不出网、同样用库内快照——私有源此刻的内容与「把那一份重新公开」无关。
  test("已下架版本走恢复且不出网", async () => {
    const world = setup();
    await world.catalog.publish(VERSION);
    await world.catalog.unpublish(VERSION);
    const firstPublishedAt = world.catalog.publicationOf(VERSION)?.firstPublishedAt;

    const change = await world.facade.publish(systemAdminActor(), {
      packageName: TEST_PACKAGE_NAME,
      exactVersion: VERSION,
      requestId: "req-4",
    });

    expect(change.action).toBe("restore");
    expect(world.registryCalls).toEqual([]);
    expect(world.catalog.visibleVersions().map((entry) => entry.exactVersion)).toEqual([VERSION]);
    expect(world.catalog.publicationOf(VERSION)?.metadataJson).toBe(snapshotJsonOf(VERSION));
    // 「首次纳入市场的时刻」不因下架与恢复而改变。
    expect(world.catalog.publicationOf(VERSION)?.firstPublishedAt).toEqual(firstPublishedAt as Date);
  });

  // 确认发布必须携带预览摘要：它是「落库的就是预览过的那一份」的唯一凭据，缺失时在出网之前就拒绝。
  test("版本不在市场且缺摘要时 400 且不出网", async () => {
    const world = setup();

    expect(
      await codeOf(
        world.facade.publish(systemAdminActor(), {
          packageName: TEST_PACKAGE_NAME,
          exactVersion: VERSION,
          requestId: "req-5",
        }),
      ),
    ).toBe("INVALID_INPUT");
    expect(world.registryCalls).toEqual([]);
    expect(world.catalogPort.publishes).toEqual([]);
  });

  // 预览与确认之间私有源上的内容可能已被替换：摘要不一致时绝不能落库，并把新读到的快照交回前端原地重新确认。
  test("摘要不一致时拦截写入并带回新快照", async () => {
    const fresh = previewOf(VERSION, "sha256:fresh");
    const world = setup({ preview: fresh });

    const error = await errorOf(
      world.facade.publish(systemAdminActor(), {
        packageName: TEST_PACKAGE_NAME,
        exactVersion: VERSION,
        previewDigest: "sha256:preview",
        requestId: "req-6",
      }),
    );

    expect(error).toBeInstanceOf(PreviewChangedError);
    expect(error.code).toBe("PREVIEW_CHANGED");
    expect(error.statusCode).toBe(409);
    expect((error as PreviewChangedError).preview.metadataDigest).toBe("sha256:fresh");
    expect(world.catalogPort.publishes).toEqual([]);
    expect(world.catalog.state()).toBeNull();
  });

  // 摘要一致时落库的必须是**刚读到的那一份**（而不是重新拼一遍的等价物），否则「存储的摘要 ≡ 存储的内容」失效。
  test("摘要一致时落库刚读到的快照", async () => {
    const fresh = previewOf(VERSION, "sha256:fresh");
    const world = setup({ preview: fresh });

    await world.facade.publish(systemAdminActor(), {
      packageName: TEST_PACKAGE_NAME,
      exactVersion: VERSION,
      previewDigest: "sha256:fresh",
      requestId: "req-7",
    });

    expect(world.registryCalls).toEqual([{ sourceId: "npm", packageName: TEST_PACKAGE_NAME, exactVersion: VERSION }]);
    expect(world.catalogPort.publishes[0]?.metadataJson).toBe(fresh.metadataJson);
    expect(world.catalog.publicationOf(VERSION)?.metadataDigest).toBe("sha256:fresh");
  });
});

describe("恢复入口", () => {
  // 恢复的前提是版本已在市场里：从未发布过的版本报 404 并提示改用发布，且不读私有源（那不是恢复的语义）。
  test("版本从未进入市场时 404 且不出网", async () => {
    const world = setup();

    expect(
      await codeOf(
        world.facade.restore(systemAdminActor(), {
          packageName: TEST_PACKAGE_NAME,
          exactVersion: VERSION,
          requestId: "req-8",
        }),
      ),
    ).toBe("PUBLICATION_NOT_FOUND");
    expect(world.registryCalls).toEqual([]);
  });

  // 恢复的显式入口与发布路径的恢复分支必须同效：都让该版本重新对公众可见。
  test("恢复已下架版本后重新可见", async () => {
    const world = setup();
    await world.catalog.publish(VERSION);
    await world.catalog.unpublish(VERSION);

    const change = await world.facade.restore(systemAdminActor(), {
      packageName: TEST_PACKAGE_NAME,
      exactVersion: VERSION,
      requestId: "req-9",
    });

    expect(change.action).toBe("restore");
    expect(world.catalog.visibleVersions().map((entry) => entry.exactVersion)).toEqual([VERSION]);
  });
});

describe("下架", () => {
  // 下架命令必须带操作人与请求标识（审计流水的唯一输入），且不预检版本是否存在——预检会让两处判定漂移。
  test("下架命令带操作人与请求标识", async () => {
    const world = setup();
    await world.catalog.publish(VERSION);

    const change = await world.facade.unpublish(systemAdminActor(), {
      packageName: TEST_PACKAGE_NAME,
      exactVersion: VERSION,
      requestId: "req-10",
    });

    expect(change.action).toBe("unpublish");
    expect(world.catalogPort.unpublishes[0]?.operatorUserId).toBe(systemAdminActor().userId);
    expect(world.catalogPort.unpublishes[0]?.requestId).toBe("req-10");
    expect(world.catalog.visibleVersions()).toEqual([]);
  });
});

describe("系统租户缓存", () => {
  // `resolveSystemTenant()` 会查身份库、必要时执行一次系统管理员引导：读路径每次都要问写权，必须只解析一次。
  test("系统租户只解析一次", async () => {
    const world = setup();

    await world.facade.list(systemAdminActor());
    await world.facade.list(memberActor());
    await world.facade.list(outsiderActor());

    expect(world.tenantReads()).toBe(1);
  });
});

describe("非法入参", () => {
  // 包名与版本必须在拼私有源 URL 之前过形状校验：编码不构成校验（`../../admin` 编码后仍是合法路径段）。
  test("非法包名与版本在出网之前被拒绝", async () => {
    const world = setup();

    expect(
      await codeOf(world.facade.preview(systemAdminActor(), { packageName: "../../admin", exactVersion: VERSION })),
    ).toBe("INVALID_INPUT");
    expect(
      await codeOf(
        world.facade.preview(systemAdminActor(), { packageName: TEST_PACKAGE_NAME, exactVersion: "^1.0.0" }),
      ),
    ).toBe("INVALID_INPUT");
    expect(world.registryCalls).toEqual([]);
  });
});
