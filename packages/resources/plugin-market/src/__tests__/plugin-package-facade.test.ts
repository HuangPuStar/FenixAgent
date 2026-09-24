import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ResourceScopeStore } from "@fenix/platform-sdk";
import { AppError, NotFoundError } from "@fenix/platform-sdk";
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
  packageDetailViewOf,
  resetMarketModuleStub,
  SYSTEM_TENANT,
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
 * 3. **两条凭据族各自的口径**。浏览面（收 actor）恒走公开口径并下推授权谓词；管理面（不收 actor）走全量口径
 *    且**不带**授权条件，归属组织与审计主体取自系统托管租户。两族混用是编译期错误，这里的断言锁的是运行期
 *    另一半：哪一面把什么条件交给了读侧。
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
  // 两条凭据族走两条口径：浏览面（收 actor）恒为公开面并把授权谓词交给读侧，管理面（不收 actor）走全量口径且
  // 不带授权条件——「没有主体」这件事必须一路传到 SQL，而不是在某一层被一个恒真条件悄悄替代。
  test("浏览面走 public 口径并带授权条件，管理面走 all 口径且不带", async () => {
    const world = setup();

    await world.facade.list(memberActor());
    await world.facade.listAll();

    expect(world.listCalls.map((call) => call.scope)).toEqual(["public", "all"]);
    expect(world.listCalls[0]?.access).toBeDefined();
    expect(world.listCalls[1]?.access).toBeUndefined();
    // 来源标识只由部署配置决定，绝不接受请求传入。
    expect(world.listCalls.map((call) => call.sourceId)).toEqual(["npm", "npm"]);
  });

  // 详情走与列表同一个口径：同一 slug 在两条路径上要么都可见、要么都 404，不存在「列表里有、详情查不到」。
  test("详情按 slug 定位，两条面各自的口径与列表一致", async () => {
    const detail = packageDetailViewOf();
    const world = setup({ detail });

    const view = await world.facade.getDetail(memberActor(), detail.slug);
    const adminView = await world.facade.getDetailAll(detail.slug);

    expect(world.detailCalls.map((call) => call.slug)).toEqual([detail.slug, detail.slug]);
    expect(world.detailCalls.map((call) => call.scope)).toEqual(["public", "all"]);
    expect(world.detailCalls[0]?.access).toBeDefined();
    expect(world.detailCalls[1]?.access).toBeUndefined();
    expect(view.packageName).toBe(detail.packageName);
    expect(adminView.packageName).toBe(detail.packageName);
  });

  // 不存在、slug 非法与「整包下架的条目」合流成同一个 404：区分它们会把市场变成内部状态探针。
  test("读侧返回空时统一映射为 404", async () => {
    const world = setup();

    expect(await errorOf(world.facade.getDetail(memberActor(), "absent"))).toBeInstanceOf(NotFoundError);
    expect(await errorOf(world.facade.getDetailAll("absent"))).toBeInstanceOf(NotFoundError);
  });
});

describe("管理面写入", () => {
  // 归属组织与审计主体都取自系统托管租户：条目落在系统租户下（否则同一份全局目录会被切散到各管理员自己的
  // 组织下），而 `owner_user_id` 是 NOT NULL 的真实用户 ID——管理面不产生「匿名条目」。
  test("发布归属与审计主体取自系统托管租户", async () => {
    const world = setup();

    await world.facade.publish({
      packageName: TEST_PACKAGE_NAME,
      exactVersion: VERSION,
      previewDigest: "sha256:preview",
      requestId: "req-2",
    });

    expect(world.catalogPort.publishes[0]?.creationScope.organizationId).toBe(SYSTEM_TENANT.organizationId);
    expect(world.catalogPort.publishes[0]?.operatorUserId).toBe(SYSTEM_TENANT.userId);
  });

  // 下架与恢复同样要能解析出审计主体，否则审计流水里会出现空操作人（真实故障形态：写入成功、审计丢失）。
  test("下架与恢复命令带系统租户的操作人", async () => {
    const world = setup();
    await world.catalog.publish(VERSION);

    await world.facade.unpublish({ packageName: TEST_PACKAGE_NAME, exactVersion: VERSION, requestId: "req-11" });
    await world.facade.restore({ packageName: TEST_PACKAGE_NAME, exactVersion: VERSION, requestId: "req-12" });

    expect(world.catalogPort.unpublishes[0]?.operatorUserId).toBe(SYSTEM_TENANT.userId);
    expect(world.catalogPort.publishes[0]?.operatorUserId).toBe(SYSTEM_TENANT.userId);
    expect(world.catalogPort.publishes[0]?.requestId).toBe("req-12");
  });
});

describe("发布分派", () => {
  // 已可见版本必须严格幂等：不出网、不比对摘要，写入用的是市场内冻结的那一份快照。
  test("已可见版本幂等且复用库内快照", async () => {
    const world = setup();
    await world.catalog.publish(VERSION);

    const change = await world.facade.publish({
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

    const change = await world.facade.publish({
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
        world.facade.publish({
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
      world.facade.publish({
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

    await world.facade.publish({
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
        world.facade.restore({
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

    const change = await world.facade.restore({
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

    const change = await world.facade.unpublish({
      packageName: TEST_PACKAGE_NAME,
      exactVersion: VERSION,
      requestId: "req-10",
    });

    expect(change.action).toBe("unpublish");
    expect(world.catalogPort.unpublishes[0]?.operatorUserId).toBe(SYSTEM_TENANT.userId);
    expect(world.catalogPort.unpublishes[0]?.requestId).toBe("req-10");
    expect(world.catalog.visibleVersions()).toEqual([]);
  });
});

describe("系统租户缓存", () => {
  // 三条写路径都要解析系统租户（归属组织与审计主体都从它来），而 `resolveSystemTenant()` 会查身份库、必要时
  // 还要执行一次系统管理员引导：同一个进程里必须只解析一次。
  test("多条写路径只解析一次系统租户", async () => {
    const world = setup();

    await world.facade.publish({
      packageName: TEST_PACKAGE_NAME,
      exactVersion: VERSION,
      previewDigest: "sha256:preview",
      requestId: "req-20",
    });
    await world.facade.unpublish({ packageName: TEST_PACKAGE_NAME, exactVersion: VERSION, requestId: "req-21" });
    await world.facade.publish({ packageName: TEST_PACKAGE_NAME, exactVersion: VERSION, requestId: "req-22" });

    expect(world.tenantReads()).toBe(1);
  });

  // 读路径不解析租户：两条面都不问「系统租户是谁」——浏览面按主体授权、管理面按系统凭据（文件头的两类面），
  // 因此读一次列表不该连带查身份库、更不该触发系统管理员引导。
  test("读路径不解析系统租户", async () => {
    const world = setup({ detail: packageDetailViewOf() });

    await world.facade.list(memberActor());
    await world.facade.getDetail(memberActor(), "any-slug");
    await world.facade.listAll();
    await world.facade.getDetailAll("any-slug");

    expect(world.tenantReads()).toBe(0);
  });
});

describe("非法入参", () => {
  // 包名与版本必须在拼私有源 URL 之前过形状校验：编码不构成校验（`../../admin` 编码后仍是合法路径段）。
  test("非法包名与版本在出网之前被拒绝", async () => {
    const world = setup();

    expect(await codeOf(world.facade.preview({ packageName: "../../admin", exactVersion: VERSION }))).toBe(
      "INVALID_INPUT",
    );
    expect(await codeOf(world.facade.preview({ packageName: TEST_PACKAGE_NAME, exactVersion: "^1.0.0" }))).toBe(
      "INVALID_INPUT",
    );
    expect(world.registryCalls).toEqual([]);
  });
});
