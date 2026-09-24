import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError } from "@fenix/platform-sdk";
import { readJson } from "@fenix/platform-sdk/testing";
import { toPackageSlug } from "../server/domain/slug";
import type { PublicationChange } from "../server/domain/types";
import { PluginMarketError } from "../server/errors";
import { PreviewChangedError } from "../server/facades/plugin-package-facade";
import type { PublicationPreview } from "../server/npm-registry/types";
import { createApiSystemPluginMarketRoutes } from "../server/routes/api/system-plugin-market";
import { TEST_PACKAGE_NAME } from "./catalog-harness";
import { createStubSessionAuthGuardPlugin, createStubSystemApiGuardPlugin } from "./guard-stubs";
import { installMarketModuleStub, packageDetailViewOf, packageViewOf, resetMarketModuleStub } from "./market-fixtures";

/**
 * `/api/system/plugin-market/*` 协议层用例（**管理面**）。
 *
 * 六条路由（列表、详情、预览、发布、下架、恢复）是平台管理动作的**唯一入口**；浏览面只剩两条读路由，本文件
 * 因此也是「写入口确实只在这里」的另一半证据。
 *
 * 三处是本层唯一能出事的地方，因此都有专门用例：
 * - **信封**：`/api/system/*` 是 `{ success: true, data }` / `{ error }`（平台既有合同），**不带 `success: false`**。
 *   照 `/web` 的形状断言会漏掉真实的协议差异。
 * - **409 的响应体**：Elysia 按 `response` schema 清理返回值，`data.preview` 必须在 schema 里显式声明，否则
 *   管理页拿到的是一个没有新快照的冲突响应——用户只能从头再走一遍预览。
 * - **`requestId` 只有在宿主挂载时才存在**：包内用例（非宿主挂载）必须得到 `null`，不得臆造标识写进审计流水。
 *
 * 授权与私有源读取都在 Facade 内（由 `plugin-package-facade.test.ts` 覆盖），本文件不重复它们；守卫替身放行
 * 且不写任何 state（见 `guard-stubs.ts`）。
 */

const VERSION = "1.0.0";
const SLUG = toPackageSlug(TEST_PACKAGE_NAME);

/** 一个能被解析的最小快照（与 `catalog-harness.snapshotJsonOf` 同形，避免用例依赖渲染细节）。 */
function previewOf(): PublicationPreview {
  const metadataJson = JSON.stringify({
    name: TEST_PACKAGE_NAME,
    version: VERSION,
    description: null,
    keywords: [],
    displayName: "投资研究专家团队",
    summary: null,
    agents: [],
    skills: [],
    servers: [],
    integrity: null,
    tarballUrl: null,
    unpackedSizeBytes: null,
    fileCount: null,
    deprecated: null,
    publishedAt: null,
  });
  return {
    ref: { sourceId: "npm", packageName: TEST_PACKAGE_NAME, exactVersion: VERSION },
    metadata: JSON.parse(metadataJson),
    metadataJson,
    metadataDigest: "sha256:preview",
  };
}

/** 一次写入的领域结果；只有 `action` 会进响应体，其余字段是领域内部的（用例据此断言视图确实投影过）。 */
function changeOf(action: PublicationChange["action"]): PublicationChange {
  return {
    action,
    packageId: "pkg-1",
    packageName: TEST_PACKAGE_NAME,
    packageSlug: SLUG,
    publicationId: "pub-1",
    exactVersion: VERSION,
    previousLatestPublicationId: null,
    latestPublicationId: "pub-1",
    affectedVersions: [VERSION],
  };
}

/**
 * 管理面只用到系统守卫，会话守卫一并注入以满足依赖形状（`PluginMarketRouteDependencies` 是两条面共用的形状，
 * 装配层对两者都注入同一份宿主守卫）。包内用例不做类型断言：形状少一项应当是编译期错误。
 */
function dependenciesWith(systemApiGuardPlugin: ReturnType<typeof createStubSystemApiGuardPlugin>) {
  return { systemApiGuardPlugin, authGuardPlugin: createStubSessionAuthGuardPlugin(null) };
}

const route = createApiSystemPluginMarketRoutes(dependenciesWith(createStubSystemApiGuardPlugin()));
const deniedRoute = createApiSystemPluginMarketRoutes(dependenciesWith(createStubSystemApiGuardPlugin(true)));

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost/api/system/plugin-market${path}`, init));
}

function postJson(path: string, body: Record<string, unknown>) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const versionBody = { packageName: TEST_PACKAGE_NAME, exactVersion: VERSION };

beforeEach(() => {
  resetMarketModuleStub();
  // 默认装入全未打桩的替身：参数校验用例在被测方法调用之前就应失败，任何越界调用会立即暴露。
  installMarketModuleStub();
});

afterEach(() => {
  resetMarketModuleStub();
});

describe("鉴权", () => {
  // 守卫拒绝（无凭据 / 凭据不匹配）时六条路由都必须 401，且 handler 一次都不执行——管理面的判据就是凭据本身，
  // 它必须在进入应用层之前兑现。
  test("守卫拒绝时六条路由全部 401 且不触碰 Facade", async () => {
    let touched = false;
    installMarketModuleStub({
      listAll: async () => {
        touched = true;
        return { items: [], total: 0 };
      },
      preview: async () => {
        touched = true;
        return previewOf();
      },
    });

    const responses = await Promise.all([
      deniedRoute.handle(new Request("http://localhost/api/system/plugin-market/packages")),
      deniedRoute.handle(new Request(`http://localhost/api/system/plugin-market/packages/${SLUG}`)),
      deniedRoute.handle(
        new Request("http://localhost/api/system/plugin-market/publish/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(versionBody),
        }),
      ),
      deniedRoute.handle(
        new Request("http://localhost/api/system/plugin-market/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(versionBody),
        }),
      ),
      deniedRoute.handle(
        new Request("http://localhost/api/system/plugin-market/unpublish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(versionBody),
        }),
      ),
      deniedRoute.handle(
        new Request("http://localhost/api/system/plugin-market/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(versionBody),
        }),
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(await readJson(response)).toEqual({
        error: { code: "UNAUTHORIZED", message: "Invalid system API key" },
      });
    }
    expect(touched).toBeFalse();
  });
});

describe("列表与详情", () => {
  // 管理面列表走全量口径：整包下架的条目也在（`hidden: true`），且**不带**逐行有效动作——本面没有主体，
  // 能进这条路由就能写。
  test("列表返回全量条目与整包下架标记", async () => {
    installMarketModuleStub({
      listAll: async () => ({ items: [packageViewOf({ hidden: true })], total: 1 }),
    });

    const body = await readJson(await request("/packages"));

    expect(body.success).toBeTrue();
    expect(body.data.total).toBe(1);
    expect(body.data.packages[0]).toEqual({
      id: "pkg-1",
      slug: SLUG,
      sourceId: "npm",
      packageName: TEST_PACKAGE_NAME,
      latestVersion: "1.0.0",
      metadata: null,
      publishedAt: 1767225600,
      hidden: true,
    });
  });

  // 详情按 slug 定位，版本历史带下架水印（秒级或 null）——这是管理面与浏览面在视图上的唯一差异来源。
  test("详情按 slug 返回带下架水印的版本历史", async () => {
    let receivedSlug = "";
    installMarketModuleStub({
      getDetailAll: async (slug) => {
        receivedSlug = slug;
        return packageDetailViewOf({
          versions: [
            {
              exactVersion: VERSION,
              metadataDigest: "sha256:preview",
              firstPublishedAt: new Date("2026-01-01T00:00:00.000Z"),
              publishedAt: new Date("2026-01-02T00:00:00.000Z"),
              unpublishedAt: null,
              isLatest: true,
            },
            {
              exactVersion: "0.9.0",
              metadataDigest: "sha256:old",
              firstPublishedAt: new Date("2025-12-01T00:00:00.000Z"),
              publishedAt: new Date("2025-12-01T00:00:00.000Z"),
              unpublishedAt: new Date("2025-12-31T00:00:00.000Z"),
              isLatest: false,
            },
          ],
        });
      },
    });

    const body = await readJson(await request(`/packages/${SLUG}`));

    expect(receivedSlug).toBe(SLUG);
    expect(body.data.package.versions).toEqual([
      {
        exactVersion: VERSION,
        metadataDigest: "sha256:preview",
        firstPublishedAt: 1767225600,
        publishedAt: 1767312000,
        isLatest: true,
        unpublishedAt: null,
      },
      {
        exactVersion: "0.9.0",
        metadataDigest: "sha256:old",
        firstPublishedAt: 1764547200,
        publishedAt: 1764547200,
        isLatest: false,
        // 2025-12-31T00:00:00.000Z
        unpublishedAt: 1767139200,
      },
    ]);
  });

  // 不存在在管理面同样是 404 + 稳定错误码，且信封是系统面的 `{ error }`（不带 `success`）。
  test("详情不存在时 404 且用系统面信封", async () => {
    installMarketModuleStub({
      getDetailAll: async () => {
        throw new NotFoundError("插件包 'absent' 不存在");
      },
    });

    const response = await request("/packages/absent");

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: { code: "NOT_FOUND", message: "插件包 'absent' 不存在" } });
  });
});

describe("预览", () => {
  // 预览只回展示与确认需要的四项：`metadataJson` 是落库的字节原文，管理页既不渲染也不回传它。
  test("预览返回快照与摘要，不含落库字节", async () => {
    let received: { packageName: string; exactVersion: string } | undefined;
    installMarketModuleStub({
      preview: async (input) => {
        received = input;
        return previewOf();
      },
    });

    const body = await readJson(await postJson("/publish/preview", versionBody));

    expect(received).toEqual(versionBody);
    expect(Object.keys(body.data.preview).sort()).toEqual([
      "exactVersion",
      "metadata",
      "metadataDigest",
      "packageName",
    ]);
    expect(body.data.preview.metadataDigest).toBe("sha256:preview");
  });

  // 部署未配置私有源时只有发布/预览失败，且必须是可辨识的专用错误码与 503——它提示的是部署问题，重试无用。
  test("未配置私有源时 503 且错误码专用", async () => {
    installMarketModuleStub({
      preview: async () => {
        throw new PluginMarketError("REGISTRY_NOT_CONFIGURED", "未配置 npm 私有源地址（PLUGIN_MARKET_REGISTRY_URL）");
      },
    });

    const response = await postJson("/publish/preview", versionBody);

    expect(response.status).toBe(503);
    expect(await readJson(response)).toEqual({
      error: {
        code: "REGISTRY_NOT_CONFIGURED",
        message: "未配置 npm 私有源地址（PLUGIN_MARKET_REGISTRY_URL）",
      },
    });
  });

  // 请求体缺字段在应用层之前被 schema 拦下（Elysia 的校验阶段早于 handler，包内为 422；宿主装配下由全局错误
  // 处理器统一改写为 400）：这是拼私有源 URL 的输入，任何读取都不该发生。
  test("请求体缺字段时不进入应用层", async () => {
    let called = false;
    installMarketModuleStub({
      preview: async () => {
        called = true;
        return previewOf();
      },
    });

    const response = await postJson("/publish/preview", { exactVersion: VERSION });

    expect(response.status).toBe(422);
    expect(called).toBeFalse();
  });
});

describe("发布", () => {
  // 确认发布把 `previewDigest` 与 `requestId` 一并交给应用层；非宿主挂载时 `requestId` 为 null（不臆造标识）。
  test("发布透传摘要并把非宿主挂载的 requestId 传成 null", async () => {
    let received: unknown;
    installMarketModuleStub({
      publish: async (input) => {
        received = input;
        return changeOf("publish");
      },
    });

    const body = await readJson(await postJson("/publish", { ...versionBody, previewDigest: "sha256:preview" }));

    expect(received).toEqual({
      packageName: TEST_PACKAGE_NAME,
      exactVersion: VERSION,
      previewDigest: "sha256:preview",
      requestId: null,
    });
    expect(body.data.change).toEqual({
      action: "publish",
      slug: SLUG,
      packageName: TEST_PACKAGE_NAME,
      exactVersion: VERSION,
    });
  });

  // 摘要与重读结果不一致是 409 且响应体必须带新快照：这是「在原位重新确认」，不是「请求非法」。
  // 这条用例同时守着「Elysia 按 schema 清理返回值」那个坑——`data.preview` 漏声明会被静默剥掉。
  test("摘要变化时 409 且带回新快照", async () => {
    installMarketModuleStub({
      publish: async () => {
        throw new PreviewChangedError(previewOf());
      },
    });

    const response = await postJson("/publish", { ...versionBody, previewDigest: "sha256:stale" });
    const body = await readJson(response);

    expect(response.status).toBe(409);
    // 系统面信封不带 `success`：契约由 `systemPreviewChangedSchema` 声明，这里按线上形状断言。
    expect(body.success).toBeUndefined();
    expect(body.error.code).toBe("PREVIEW_CHANGED");
    expect(body.data.preview.metadataDigest).toBe("sha256:preview");
    expect(body.data.preview.exactVersion).toBe(VERSION);
  });

  // 缺摘要是应用层判定（协议层不复制这条规则），错误码稳定映射为 400。
  test("缺摘要时 400", async () => {
    installMarketModuleStub({
      publish: async () => {
        throw new PluginMarketError("INVALID_INPUT", "确认发布必须携带预览摘要（previewDigest）");
      },
    });

    const response = await postJson("/publish", versionBody);

    expect(response.status).toBe(400);
    expect((await readJson(response)).error.code).toBe("INVALID_INPUT");
  });

  // 幂等分支的动作名与其它分支不同（`noop`），管理页据此决定提示文案。
  test("幂等分支回 noop", async () => {
    installMarketModuleStub({ publish: async () => changeOf("noop") });

    const body = await readJson(await postJson("/publish", { ...versionBody, previewDigest: "sha256:preview" }));

    expect(body.data.change.action).toBe("noop");
  });
});

describe("下架与恢复", () => {
  // 下架只回「发生了什么」，不回刷新后的条目：列表顺序与展示快照都可能变，管理页本来就要重新拉一次。
  test("下架返回动作结果", async () => {
    let received: unknown;
    installMarketModuleStub({
      unpublish: async (input) => {
        received = input;
        return changeOf("unpublish");
      },
    });

    const body = await readJson(await postJson("/unpublish", versionBody));

    expect(received).toEqual({ ...versionBody, requestId: null });
    expect(body.data.change).toEqual({
      action: "unpublish",
      slug: SLUG,
      packageName: TEST_PACKAGE_NAME,
      exactVersion: VERSION,
    });
  });

  // 版本从未进入市场时恢复报 404（那是「发布」而不是「恢复」），错误码稳定可分支。
  test("恢复未知版本时 404", async () => {
    installMarketModuleStub({
      restore: async () => {
        throw new PluginMarketError("PUBLICATION_NOT_FOUND", "该版本从未进入市场，无法恢复；请改用发布");
      },
    });

    const response = await postJson("/restore", versionBody);

    expect(response.status).toBe(404);
    expect((await readJson(response)).error.code).toBe("PUBLICATION_NOT_FOUND");
  });

  // 显式恢复与发布路径的恢复分支同效：管理页两条入口之间不该有行为差异。
  test("恢复已下架版本返回 restore 动作", async () => {
    installMarketModuleStub({ restore: async () => changeOf("restore") });

    const body = await readJson(await postJson("/restore", versionBody));

    expect(body.data.change.action).toBe("restore");
  });
});
