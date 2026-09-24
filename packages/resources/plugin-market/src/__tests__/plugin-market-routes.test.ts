import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ActorContext } from "@fenix/platform-sdk";
import { ForbiddenError, NotFoundError } from "@fenix/platform-sdk";
import { readJson } from "@fenix/platform-sdk/testing";
import { toPackageSlug } from "../server/domain/slug";
import { PluginMarketError } from "../server/errors";
import { PreviewChangedError } from "../server/facades/plugin-package-facade";
import type { PublicationPreview } from "../server/npm-registry/types";
import { createWebPluginMarketConfigRoutes } from "../server/routes/web/config/plugin-market";
import { TEST_PACKAGE_NAME } from "./catalog-harness";
import { createStubSessionAuthGuardPlugin } from "./guard-stubs";
import {
  installMarketModuleStub,
  packageDetailViewOf,
  packageViewOf,
  resetMarketModuleStub,
  systemAdminActor,
} from "./market-fixtures";

/**
 * `/web/config/plugin-market/*` 协议层用例。
 *
 * 授权、读口径、发布状态分派与私有源读取都在 Facade 内（由 `plugin-package-facade.test.ts` 覆盖），本文件只
 * 覆盖协议层职责：参数形状、请求映射、视图映射与错误码 → 状态码的映射。
 *
 * 两处是本层唯一能出事的地方，因此都有专门用例：
 * - **409 的响应体**：Elysia 按 `response` schema 清理返回值，`data.preview` 必须在 schema 里显式声明，否则
 *   前端拿到的是一个没有新快照的冲突响应——发布对话框只能让用户从头再走一遍预览。
 * - **`requestId` 只有在宿主挂载时才存在**：包内用例（非宿主挂载）必须得到 `null`，不得臆造标识写进审计流水。
 */

const VERSION = "1.0.0";

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

const route = createWebPluginMarketConfigRoutes({
  authGuardPlugin: createStubSessionAuthGuardPlugin(systemAdminActor()),
});
const anonymousRoute = createWebPluginMarketConfigRoutes({
  authGuardPlugin: createStubSessionAuthGuardPlugin(null),
});

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
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
  // 守卫放行但不注入主体（例如未绑定组织的 API Key）：六条路由都必须 401，且一次都不触碰应用层。
  test("无组织上下文的请求全部 401 且不触碰 Facade", async () => {
    let touched = false;
    installMarketModuleStub({
      list: async () => {
        touched = true;
        return { items: [], total: 0, canPublish: true };
      },
      preview: async () => {
        touched = true;
        return previewOf();
      },
    });

    const responses = await Promise.all([
      anonymousRoute.handle(new Request("http://localhost/config/plugin-market/packages")),
      anonymousRoute.handle(
        new Request(`http://localhost/config/plugin-market/packages/${toPackageSlug(TEST_PACKAGE_NAME)}`),
      ),
      anonymousRoute.handle(
        new Request("http://localhost/config/plugin-market/publish/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(versionBody),
        }),
      ),
      anonymousRoute.handle(
        new Request("http://localhost/config/plugin-market/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(versionBody),
        }),
      ),
      anonymousRoute.handle(
        new Request("http://localhost/config/plugin-market/unpublish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(versionBody),
        }),
      ),
      anonymousRoute.handle(
        new Request("http://localhost/config/plugin-market/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(versionBody),
        }),
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(await readJson(response)).toEqual({
        success: false,
        error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" },
      });
    }
    expect(touched).toBeFalse();
  });
});

describe("列表与详情", () => {
  // 列表把可信主体原样交给 Facade，并按视图映射返回：秒级时间戳、展示快照、归属 scope、有效动作与页面级能力位。
  test("列表返回 packages、total、canPublish 与逐字段视图", async () => {
    let received: ActorContext | undefined;
    installMarketModuleStub({
      list: async (actor) => {
        received = actor;
        return { items: [{ ...packageViewOf(), access: { actions: ["read", "create"] } }], total: 1, canPublish: true };
      },
    });

    const body = await readJson(await request("/config/plugin-market/packages"));

    expect(body.data.total).toBe(1);
    // 能力位随响应透传：前端据此决定「发布版本」入口是否出现，不自己按已有条目推导。
    expect(body.data.canPublish).toBe(true);
    expect(body.data.packages[0]).toEqual({
      id: "pkg-1",
      slug: toPackageSlug(TEST_PACKAGE_NAME),
      sourceId: "npm",
      packageName: TEST_PACKAGE_NAME,
      latestVersion: "1.0.0",
      metadata: null,
      // 秒级时间戳：2026-01-01T00:00:00.000Z
      publishedAt: 1767225600,
      hidden: false,
      scope: { organizationId: "org-test", visibility: "public" },
      access: { actions: ["read", "create"] },
    });
    expect(received).toEqual(systemAdminActor());
  });

  // 详情按 slug 定位并把路径段原样交给 Facade；版本历史带下架水印（秒级或 null）。
  test("详情按 slug 返回版本历史", async () => {
    let receivedSlug = "";
    installMarketModuleStub({
      getDetail: async (_actor, slug) => {
        receivedSlug = slug;
        return {
          ...packageDetailViewOf({
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
          }),
          access: { actions: ["read", "create"] },
        };
      },
    });

    const body = await readJson(await request(`/config/plugin-market/packages/${toPackageSlug(TEST_PACKAGE_NAME)}`));

    expect(receivedSlug).toBe(toPackageSlug(TEST_PACKAGE_NAME));
    expect(body.data.package.versions).toEqual([
      {
        exactVersion: VERSION,
        metadataDigest: "sha256:preview",
        firstPublishedAt: 1767225600,
        publishedAt: 1767312000,
        unpublishedAt: null,
        isLatest: true,
      },
      {
        exactVersion: "0.9.0",
        metadataDigest: "sha256:old",
        firstPublishedAt: 1764547200,
        publishedAt: 1764547200,
        unpublishedAt: 1767139200,
        isLatest: false,
      },
    ]);
  });

  // 「不存在」在协议层是 404 + 稳定错误码，前端据此提示包名可能有误，而不是提示稍后重试。
  test("详情不存在时 404", async () => {
    installMarketModuleStub({
      getDetail: async () => {
        throw new NotFoundError("插件包 'absent' 不存在");
      },
    });

    const response = await request("/config/plugin-market/packages/absent");

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "插件包 'absent' 不存在" },
    });
  });

  // slug 的形状校验**不在协议层**：它由读侧解析（`fromPackageSlug`）并与其他「不可见」原因合流成同一个 404
  // ——在协议层区分「slug 非法」与「条目不存在」会把市场变成内部状态探针，而 `z.string().min(1)` 这类弱校验
  // 只会让非法 slug 落进另一条错误分支。协议层的职责只是把路径段原样交给读侧。
  test("非法 slug 原样交给读侧并统一 404", async () => {
    let received = "";
    installMarketModuleStub({
      getDetail: async (_actor, slug) => {
        received = slug;
        throw new NotFoundError(`插件包 '${slug}' 不存在`);
      },
    });

    const response = await request("/config/plugin-market/packages/not-a-slug!");

    expect(response.status).toBe(404);
    expect(received).toBe("not-a-slug!");
  });
});

describe("预览", () => {
  // 预览只回展示与确认需要的四项：`metadataJson` 是落库的字节原文，前端既不渲染也不回传它。
  test("预览返回快照与摘要，不含落库字节", async () => {
    let received: { packageName: string; exactVersion: string } | undefined;
    installMarketModuleStub({
      preview: async (_actor, input) => {
        received = input;
        return previewOf();
      },
    });

    const body = await readJson(await postJson("/config/plugin-market/publish/preview", versionBody));

    expect(received).toEqual(versionBody);
    expect(Object.keys(body.data.preview).sort()).toEqual([
      "exactVersion",
      "metadata",
      "metadataDigest",
      "packageName",
    ]);
    expect(body.data.preview.metadataDigest).toBe("sha256:preview");
    expect(body.data.preview.exactVersion).toBe(VERSION);
  });

  // 部署未配置私有源时只有发布/预览失败，且必须是可辨识的专用错误码与 503——它提示的是部署问题，重试无用。
  test("未配置私有源时 503 且错误码专用", async () => {
    installMarketModuleStub({
      preview: async () => {
        throw new PluginMarketError("REGISTRY_NOT_CONFIGURED", "未配置 npm 私有源地址（PLUGIN_MARKET_REGISTRY_URL）");
      },
    });

    const response = await postJson("/config/plugin-market/publish/preview", versionBody);

    expect(response.status).toBe(503);
    expect(await readJson(response)).toEqual({
      success: false,
      error: {
        code: "REGISTRY_NOT_CONFIGURED",
        message: "未配置 npm 私有源地址（PLUGIN_MARKET_REGISTRY_URL）",
      },
    });
  });

  // 请求体缺少必填字段在应用层之前被 schema 拦下（Elysia 的校验阶段早于 handler，包内为 422；宿主装配下由
  // 全局错误处理器统一改写为 400，与本仓其它 `/web` 路由一致）：这是拼私有源 URL 的输入，任何读取都不该发生。
  test("请求体缺字段时不进入应用层", async () => {
    let called = false;
    installMarketModuleStub({
      preview: async () => {
        called = true;
        return previewOf();
      },
    });

    const response = await postJson("/config/plugin-market/publish/preview", { exactVersion: VERSION });

    expect(response.status).toBe(422);
    expect(called).toBeFalse();
  });
});

describe("发布", () => {
  // 确认发布把 `previewDigest` 与 `requestId` 一并交给应用层；非宿主挂载时 `requestId` 为 null（不臆造标识）。
  test("发布透传摘要并把非宿主挂载的 requestId 传成 null", async () => {
    let received: unknown;
    installMarketModuleStub({
      publish: async (_actor, input) => {
        received = input;
        return {
          action: "publish",
          packageId: "pkg-1",
          packageName: TEST_PACKAGE_NAME,
          packageSlug: toPackageSlug(TEST_PACKAGE_NAME),
          publicationId: "pub-1",
          exactVersion: VERSION,
          previousLatestPublicationId: null,
          latestPublicationId: "pub-1",
          affectedVersions: [VERSION],
        };
      },
    });

    const body = await readJson(
      await postJson("/config/plugin-market/publish", { ...versionBody, previewDigest: "sha256:preview" }),
    );

    expect(received).toEqual({
      packageName: TEST_PACKAGE_NAME,
      exactVersion: VERSION,
      previewDigest: "sha256:preview",
      requestId: null,
    });
    expect(body.data.change).toEqual({
      action: "publish",
      slug: toPackageSlug(TEST_PACKAGE_NAME),
      packageName: TEST_PACKAGE_NAME,
      exactVersion: VERSION,
    });
  });

  // 摘要与重读结果不一致是 409 且响应体必须带新快照：这是「在原位重新确认」，不是「请求非法」。
  // 这条用例同时守着「Elysia 按 schema 清理返回值」那个坑——`data.preview` 漏声明会被静默剥掉。
  test("摘要变化时 409 且带回新快照", async () => {
    const fresh = previewOf();
    installMarketModuleStub({
      publish: async () => {
        throw new PreviewChangedError(fresh);
      },
    });

    const response = await postJson("/config/plugin-market/publish", {
      ...versionBody,
      previewDigest: "sha256:stale",
    });
    const body = await readJson(response);

    expect(response.status).toBe(409);
    expect(body.success).toBeFalse();
    expect(body.error.code).toBe("PREVIEW_CHANGED");
    expect(body.data.preview.metadataDigest).toBe("sha256:preview");
    expect(body.data.preview.exactVersion).toBe(VERSION);
  });

  // 缺摘要由应用层判定（协议层不该复制这条规则），错误码稳定映射为 400。
  test("缺摘要时 400", async () => {
    installMarketModuleStub({
      publish: async () => {
        throw new PluginMarketError("INVALID_INPUT", "确认发布必须携带预览摘要（previewDigest）");
      },
    });

    const response = await postJson("/config/plugin-market/publish", versionBody);

    expect(response.status).toBe(400);
    expect((await readJson(response)).error.code).toBe("INVALID_INPUT");
  });

  // 非系统管理员的写请求是 403，且错误文案与错误码都由应用层给出（协议层不复制权限规则）。
  test("无写权时 403", async () => {
    installMarketModuleStub({
      publish: async () => {
        throw new ForbiddenError("只有平台系统管理员可以发布或下架插件");
      },
    });

    const response = await postJson("/config/plugin-market/publish", {
      ...versionBody,
      previewDigest: "sha256:preview",
    });

    expect(response.status).toBe(403);
    expect((await readJson(response)).error).toEqual({
      code: "FORBIDDEN",
      message: "只有平台系统管理员可以发布或下架插件",
    });
  });
});

describe("下架与恢复", () => {
  // 下架只回「发生了什么」，不回刷新后的条目：列表顺序与展示快照都可能变，前端本来就要重新拉一次。
  test("下架返回动作结果", async () => {
    installMarketModuleStub({
      unpublish: async () => ({
        action: "unpublish",
        packageId: "pkg-1",
        packageName: TEST_PACKAGE_NAME,
        packageSlug: toPackageSlug(TEST_PACKAGE_NAME),
        publicationId: "pub-1",
        exactVersion: VERSION,
        previousLatestPublicationId: "pub-1",
        latestPublicationId: null,
        affectedVersions: [VERSION],
      }),
    });

    const body = await readJson(await postJson("/config/plugin-market/unpublish", versionBody));

    expect(body.data.change.action).toBe("unpublish");
    expect(body.data.change.exactVersion).toBe(VERSION);
  });

  // 版本从未进入市场时恢复报 404（那是「发布」而不是「恢复」），错误码稳定可分支。
  test("恢复未知版本时 404", async () => {
    installMarketModuleStub({
      restore: async () => {
        throw new PluginMarketError("PUBLICATION_NOT_FOUND", "该版本从未进入市场，无法恢复；请改用发布");
      },
    });

    const response = await postJson("/config/plugin-market/restore", versionBody);

    expect(response.status).toBe(404);
    expect((await readJson(response)).error.code).toBe("PUBLICATION_NOT_FOUND");
  });
});
