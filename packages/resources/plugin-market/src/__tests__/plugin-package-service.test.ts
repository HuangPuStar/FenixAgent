import { describe, expect, test } from "bun:test";
import type { ResourceQueryConstraint, ResourceScope } from "@fenix/platform-sdk";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { PackageVersionView } from "../server/domain/package-view";
import { toPackageSlug } from "../server/domain/slug";
import type { PackageIdentity } from "../server/repositories/plugin-package";
import type { PluginPackageReadRepository, ScopedPluginPackageRow } from "../server/repositories/plugin-package-read";
import { createPluginPackageService } from "../server/services/plugin-package-service";
import { digestOf, snapshotJsonOf, TEST_ORGANIZATION_ID, TEST_PACKAGE_NAME, TEST_SOURCE_ID } from "./catalog-harness";

/**
 * 读侧服务的契约测试。
 *
 * 这里锁定的是**一条安全边界**：读口径 → SQL 条件的下推。市场条目的可见性有两层——包级（整包下架 =
 * `latest_publication_id IS NULL`）与版本级（`unpublished_at` 水印）——两层都必须在数据库查询阶段完成：
 *
 * - 包级若在应用层过滤，`total` 与列表项会来自两个不同的可见集合，前端分页与「共 N 个」都会对不上。
 * - 版本级由投影（`toPackageDetailView`）按 `includeHidden` 过滤，因此**写权主体的详情必须带上已下架版本**，
 *   而非写权主体拿到的是过滤后的历史。
 *
 * 与其余用例一样：测试进程里没有 Postgres，因此读侧仓储用记录入参的替身。被验证的是服务如何组装条件与投影，
 * 不是 SQL 能不能跑（那是仓储与集成用例的事）。
 */

const dialect = new PgDialect();

/** 把服务交下来的业务条件还原成可读文本，供断言锁谓词。 */
const describeConditions = (conditions: readonly SQL[] | undefined): string[] =>
  (conditions ?? []).map((condition) => dialect.sqlToQuery(condition).sql);

/** 授权条件句柄：服务只透传，不解析。 */
const access = {
  resourceType: "plugin-market-package",
  action: "read",
  provider: "test",
} as unknown as ResourceQueryConstraint;

const scope: ResourceScope = { organizationId: TEST_ORGANIZATION_ID, visibility: "public" };

function packageRow(overrides: Partial<ScopedPluginPackageRow> = {}): ScopedPluginPackageRow {
  return {
    id: "pkg-1",
    sourceId: TEST_SOURCE_ID,
    packageName: TEST_PACKAGE_NAME,
    organizationId: TEST_ORGANIZATION_ID,
    ownerUserId: "user-admin",
    visibility: "public",
    latestPublicationId: "pub-2",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    scope,
    ...overrides,
  } as ScopedPluginPackageRow;
}

function publicationRow(overrides: Partial<Record<string, unknown>> = {}) {
  const version = (overrides.exactVersion as string | undefined) ?? "2.0.0";
  return {
    id: `pub-${version}`,
    packageId: "pkg-1",
    exactVersion: version,
    metadataJson: snapshotJsonOf(version),
    metadataDigest: digestOf(version),
    firstPublishedAt: new Date("2026-01-01T00:00:00.000Z"),
    publishedAt: new Date("2026-01-02T00:00:00.000Z"),
    unpublishedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as never;
}

/** 读侧仓储替身：记录入参，返回预制行。 */
function createFakeRepository(
  input: {
    readonly rows?: readonly ScopedPluginPackageRow[];
    readonly total?: number;
    readonly publications?: readonly unknown[];
  } = {},
) {
  const listInputs: Parameters<PluginPackageReadRepository["listReadable"]>[0][] = [];
  const findInputs: Parameters<PluginPackageReadRepository["findReadable"]>[0][] = [];
  const publicationInputs: Parameters<PluginPackageReadRepository["listPublications"]>[0][] = [];
  const repository: PluginPackageReadRepository = {
    async listReadable(call) {
      listInputs.push(call);
      return { items: input.rows ?? [], total: input.total ?? input.rows?.length ?? 0 };
    },
    async findReadable(call) {
      findInputs.push(call);
      return (input.rows ?? [])[0];
    },
    async listPublications(call) {
      publicationInputs.push(call);
      return [...(input.publications ?? [])] as never;
    },
  };
  return { repository, listInputs, findInputs, publicationInputs };
}

describe("读口径下推", () => {
  // 公开面的可见性必须作为 SQL 条件下推：整包下架的条目（latest 指针为 NULL）根本不该进入这一集合，
  // 否则总数与列表项会来自两个不同的可见集合。
  test("公开面把「整包下架」下推为 SQL 条件", async () => {
    const fake = createFakeRepository();
    const service = createPluginPackageService(fake.repository);

    await service.list({ access, sourceId: TEST_SOURCE_ID, scope: "public" });

    const conditions = describeConditions(fake.listInputs[0]?.businessWhere);
    expect(conditions).toHaveLength(2);
    expect(conditions[0]).toContain("source_id");
    expect(conditions[1]).toContain('"latest_publication_id" is not null');
  });

  // 管理面（写权主体）不加可见性条件：整包下架的条目要能被管理台看到并恢复。
  test("管理面只按来源过滤", async () => {
    const fake = createFakeRepository();
    const service = createPluginPackageService(fake.repository);

    await service.list({ access, sourceId: TEST_SOURCE_ID, scope: "all" });

    const conditions = describeConditions(fake.listInputs[0]?.businessWhere);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toContain("source_id");
  });

  // 来源标识是 slug 定位符成立的前提：同一包名在多个来源下各有一条聚合根时，slug 无法区分它们。
  test("详情按来源与包名双条件定位", async () => {
    const fake = createFakeRepository({ rows: [packageRow()] });
    const service = createPluginPackageService(fake.repository);

    await service.findDetailBySlug({
      access,
      sourceId: TEST_SOURCE_ID,
      scope: "public",
      slug: toPackageSlug(TEST_PACKAGE_NAME),
    });

    const conditions = describeConditions(fake.findInputs[0]?.businessWhere);
    expect(conditions[0]).toContain("source_id");
    expect(conditions[1]).toContain("package_name");
  });

  // 非法 slug 连包名都还原不出来，必须在查库之前返回：否则它会变成一次无意义的全表扫描，
  // 而且「非法编码」与「条目不存在」最终都必须是同一个 404（路由侧用例覆盖）。
  test("非法 slug 不查库", async () => {
    const fake = createFakeRepository();
    const service = createPluginPackageService(fake.repository);

    const detail = await service.findDetailBySlug({
      access,
      sourceId: TEST_SOURCE_ID,
      scope: "public",
      slug: "not-a-slug!",
    });

    expect(detail).toBeUndefined();
    expect(fake.findInputs).toEqual([]);
  });
});

describe("视图投影", () => {
  // 列表一次读回全部包的版本（无 N+1），且展示版本取 latest 指针指向的那一行。
  test("列表批量读版本并展示 latest 指向的版本", async () => {
    const fake = createFakeRepository({
      rows: [packageRow({ latestPublicationId: "pub-2.0.0" })],
      publications: [publicationRow({ exactVersion: "1.0.0" }), publicationRow({ exactVersion: "2.0.0" })],
    });
    const service = createPluginPackageService(fake.repository);

    const { items } = await service.list({ access, sourceId: TEST_SOURCE_ID, scope: "public" });

    // 一次批量查询覆盖整个列表，而不是每行一次。
    expect(fake.publicationInputs).toHaveLength(1);
    expect(fake.publicationInputs[0]?.packageIds).toEqual(["pkg-1"]);
    expect(items[0]?.latestVersion).toBe("2.0.0");
    expect(items[0]?.metadata?.version).toBe("2.0.0");
  });

  // 整包下架（latest 指针为 NULL）时展示回退到最新版本，页面不会退化成一个只有包名的空条目。
  test("整包下架时展示回退到最新版本", async () => {
    const fake = createFakeRepository({
      rows: [packageRow({ latestPublicationId: null })],
      publications: [
        publicationRow({ exactVersion: "1.0.0", unpublishedAt: new Date("2026-01-03T00:00:00.000Z") }),
        publicationRow({ exactVersion: "2.0.0", unpublishedAt: new Date("2026-01-04T00:00:00.000Z") }),
      ],
    });
    const service = createPluginPackageService(fake.repository);

    const { items } = await service.list({ access, sourceId: TEST_SOURCE_ID, scope: "all" });

    expect(items[0]?.hidden).toBeTrue();
    expect(items[0]?.latestVersion).toBeNull();
    expect(items[0]?.metadata?.version).toBe("2.0.0");
  });

  // 版本历史：写权主体看得到已下架版本（带水印），非写权主体只看得到可见版本——两者是同一份投影函数
  // 按 `includeHidden` 的两个分支，因此不存在「列表里有、详情却缺版本」这类不一致。
  test("版本历史按口径过滤下架版本", async () => {
    const publications = [
      publicationRow({ exactVersion: "1.0.0", unpublishedAt: new Date("2026-01-03T00:00:00.000Z") }),
      publicationRow({ exactVersion: "2.0.0" }),
    ];

    const readVersions = async (readScope: "public" | "all"): Promise<PackageVersionView[]> => {
      const fake = createFakeRepository({ rows: [packageRow()], publications });
      const service = createPluginPackageService(fake.repository);
      const detail = await service.findDetailBySlug({
        access,
        sourceId: TEST_SOURCE_ID,
        scope: readScope,
        slug: toPackageSlug(TEST_PACKAGE_NAME),
      });
      return [...(detail?.versions ?? [])];
    };

    const adminVersions = await readVersions("all");
    const publicVersions = await readVersions("public");

    expect(adminVersions.map((entry) => entry.exactVersion)).toEqual(["2.0.0", "1.0.0"]);
    expect(adminVersions[1]?.unpublishedAt).toEqual(new Date("2026-01-03T00:00:00.000Z"));
    expect(publicVersions.map((entry) => entry.exactVersion)).toEqual(["2.0.0"]);
  });

  // 列表顺序由展示快照的发布时刻决定（最近发布在前），且平局时顺序稳定——两次请求不能给出不同顺序。
  test("列表按最近发布排序", async () => {
    const fake = createFakeRepository({
      rows: [
        packageRow({ id: "pkg-old", packageName: "acme-old", latestPublicationId: "pub-old" }),
        packageRow({ id: "pkg-new", packageName: "acme-new", latestPublicationId: "pub-new" }),
      ],
      publications: [
        publicationRow({ id: "pub-old", packageId: "pkg-old", publishedAt: new Date("2026-01-01T00:00:00.000Z") }),
        publicationRow({ id: "pub-new", packageId: "pkg-new", publishedAt: new Date("2026-02-01T00:00:00.000Z") }),
      ],
    });
    const service = createPluginPackageService(fake.repository);

    const { items } = await service.list({ access, sourceId: TEST_SOURCE_ID, scope: "public" });

    expect(items.map((item) => item.packageName)).toEqual(["acme-new", "acme-old"]);
  });
});

describe("来源隔离", () => {
  // 来源标识由部署配置给出，读侧不得把它变成可选条件：换掉配置等于换一个目录，旧来源的行不再展示。
  test("配置的来源标识始终出现在条件里", async () => {
    const fake = createFakeRepository();
    const service = createPluginPackageService(fake.repository);
    const identity: PackageIdentity = { sourceId: "npm-internal", packageName: TEST_PACKAGE_NAME };

    await service.list({ access, sourceId: identity.sourceId, scope: "all" });

    expect(describeConditions(fake.listInputs[0]?.businessWhere)[0]).toContain("source_id");
    expect(dialect.sqlToQuery(fake.listInputs[0]?.businessWhere?.[0] as SQL).params).toEqual(["npm-internal"]);
  });
});
