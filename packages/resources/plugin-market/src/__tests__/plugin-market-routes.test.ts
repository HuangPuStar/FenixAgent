import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ActorContext } from "@fenix/platform-sdk";
import { NotFoundError } from "@fenix/platform-sdk";
import { readJson } from "@fenix/platform-sdk/testing";
import { toPackageSlug } from "../server/domain/slug";
import { createWebPluginMarketConfigRoutes } from "../server/routes/web/config/plugin-market";
import { TEST_PACKAGE_NAME } from "./catalog-harness";
import { createStubSessionAuthGuardPlugin, createStubSystemApiGuardPlugin } from "./guard-stubs";
import {
  installMarketModuleStub,
  packageDetailViewOf,
  packageViewOf,
  resetMarketModuleStub,
  systemAdminActor,
} from "./market-fixtures";

/**
 * `/web/config/plugin-market/*` 协议层用例（**浏览面**）。
 *
 * 这面只有两条读路由——发布、下架与恢复走系统凭据的 `/api/system/plugin-market/*`
 * （`plugin-market-system-routes.test.ts`）。因此本文件锁的不是「写请求怎么映射」，而是**写入口确实不在
 * 这面**：任何 POST 都不该被本应用接住。
 *
 * 授权、读口径与私有源读取都在 Facade 内（由 `plugin-package-facade.test.ts` 覆盖），本文件只覆盖协议层职责：
 * 参数形状、请求映射与视图映射。视图映射是本层最容易悄悄漂移的地方——把领域字段照搬进响应会给前端留下
 * 没有消费方的能力位，因此清单型用例按**逐字段相等**断言，而不是只看几个关键字段。
 */

const VERSION = "1.0.0";

const route = createWebPluginMarketConfigRoutes({
  authGuardPlugin: createStubSessionAuthGuardPlugin(systemAdminActor()),
  systemApiGuardPlugin: createStubSystemApiGuardPlugin(),
});
const anonymousRoute = createWebPluginMarketConfigRoutes({
  authGuardPlugin: createStubSessionAuthGuardPlugin(null),
  systemApiGuardPlugin: createStubSystemApiGuardPlugin(),
});

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}

beforeEach(() => {
  resetMarketModuleStub();
  // 默认装入全未打桩的替身：参数校验用例在被测方法调用之前就应失败，任何越界调用会立即暴露。
  installMarketModuleStub();
});

afterEach(() => {
  resetMarketModuleStub();
});

describe("鉴权", () => {
  // 守卫放行但不注入主体（例如未绑定组织的 API Key）：两条读路由都必须 401，且一次都不触碰应用层。
  test("无组织上下文的请求全部 401 且不触碰 Facade", async () => {
    let touched = false;
    installMarketModuleStub({
      list: async () => {
        touched = true;
        return { items: [], total: 0 };
      },
      getDetail: async () => {
        touched = true;
        throw new NotFoundError("不应被调用");
      },
    });

    const responses = await Promise.all([
      anonymousRoute.handle(new Request("http://localhost/config/plugin-market/packages")),
      anonymousRoute.handle(
        new Request(`http://localhost/config/plugin-market/packages/${toPackageSlug(TEST_PACKAGE_NAME)}`),
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

describe("列表", () => {
  // 列表把可信主体原样交给 Facade，并按浏览面视图映射返回：秒级时间戳与展示快照，**没有**逐行动作、没有
  // 恒为 false 的下架标记、没有归属 scope——浏览面没有任何写入口，这些字段在这里没有消费方。
  test("列表返回 packages 与 total，且只含浏览字段", async () => {
    let received: ActorContext | undefined;
    installMarketModuleStub({
      list: async (actor) => {
        received = actor;
        return { items: [packageViewOf()], total: 1 };
      },
    });

    const body = await readJson(await request("/config/plugin-market/packages"));

    expect(body.success).toBeTrue();
    expect(body.data.total).toBe(1);
    expect(body.data.packages).toHaveLength(1);
    expect(body.data.packages[0]).toEqual({
      id: "pkg-1",
      slug: toPackageSlug(TEST_PACKAGE_NAME),
      sourceId: "npm",
      packageName: TEST_PACKAGE_NAME,
      latestVersion: "1.0.0",
      metadata: null,
      // 秒级时间戳：2026-01-01T00:00:00.000Z
      publishedAt: 1767225600,
    });
    expect(received).toEqual(systemAdminActor());
  });

  // 空目录是正常状态而不是错误：协议层照常回 200 + 空数组，页面据此渲染空状态。
  test("空列表回 200 与空数组", async () => {
    installMarketModuleStub({ list: async () => ({ items: [], total: 0 }) });

    const response = await request("/config/plugin-market/packages");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: { packages: [], total: 0 } });
  });
});

describe("详情", () => {
  // 详情按 slug 定位并把路径段原样交给 Facade；版本历史只含可见版本，因此不带下架水印。
  test("详情按 slug 返回版本历史且不带下架水印", async () => {
    let receivedSlug = "";
    installMarketModuleStub({
      getDetail: async (_actor, slug) => {
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
          ],
        });
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
        isLatest: true,
      },
    ]);
    expect(body.data.package.slug).toBe(toPackageSlug(TEST_PACKAGE_NAME));
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
