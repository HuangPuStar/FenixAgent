// web/__tests__/plugin-market-admin-utils.test.ts
// 插件市场**管理面独有**的展示层纯逻辑用例：多一档「已下架」的范围口径、409 冲突体解析、写入结果 → 提示映射。
//
// 这三件事在浏览面没有消费方（公开口径里不存在「已下架」这一档、没有写路径），因此它们的用例也与共用逻辑
// 分开：`plugin-market-utils.test.ts` 测的是「同一个条目对谁都给同一个答案」，这里测的是「只有管理台才会问的
// 三个问题」。放在一起会让读者以为过滤有两份实现。
//
// 为什么这几条值得断言：
// - 范围口径与过滤各写一份，症状是「同一个包，管理台筛不到、控制台筛得到」；
// - 冲突体解析写错类型判断（只接 `ApiError` 而实际是失败信封），症状是「点了确认没反应」；
// - `noop` 与 `publish` 映射到同一条文案，症状是「用户以为私有源上的新内容已经进了市场」。

import { describe, expect, test } from "bun:test";
import type { PluginPackageMetadata } from "../api/plugin-market-types";
import type { PluginAdminPackageView } from "../api/system-plugin-market-types";
import {
  changeToastKey,
  countAdminScopes,
  filterAdminPackages,
  readPreviewChangedPayload,
} from "../lib/plugin-market-admin-utils";

/** 构造一个最小管理面条目视图；`hidden` 默认 false（多数用例关心的是可见条目）。 */
function adminView(overrides: Partial<PluginAdminPackageView> = {}): PluginAdminPackageView {
  return {
    id: "pkg-1",
    slug: "acme-team",
    sourceId: "npm",
    packageName: "@acme/investment-team",
    latestVersion: "1.2.0",
    metadata: snapshot({ agents: [{ id: "analyst", name: "分析师", description: null }] }),
    publishedAt: 1_767_225_600,
    hidden: false,
    ...overrides,
  };
}

/** 快照按用例需要改几个字段；其余保持可用形状。 */
function snapshot(overrides: Partial<PluginPackageMetadata> = {}): PluginPackageMetadata {
  return {
    name: "@acme/investment-team",
    version: "1.2.0",
    description: "投研专家团队",
    keywords: ["投资"],
    displayName: "投研团队",
    summary: "面向二级市场的投研 Agent 团队",
    agents: [],
    skills: [],
    servers: [],
    integrity: null,
    tarballUrl: null,
    unpackedSizeBytes: null,
    fileCount: null,
    deprecated: null,
    publishedAt: null,
    ...overrides,
  };
}

/** 整包下架：没有可见版本，快照仍是最后一次发布的那一份。 */
const WITHDRAWN = adminView({
  id: "pkg-2",
  slug: "acme-connector",
  packageName: "@acme/connector",
  latestVersion: null,
  hidden: true,
  metadata: snapshot({ name: "@acme/connector", servers: [{ id: "market-data", transport: "stdio", runtime: null }] }),
});

/** 既下架、又声明了 agent 成员：用来证明「已下架」这一档不改变其它档的判据。 */
const WITHDRAWN_TEAM = adminView({
  id: "pkg-3",
  slug: "acme-toolkit",
  packageName: "@acme/toolkit",
  latestVersion: null,
  hidden: true,
  metadata: snapshot({
    name: "@acme/toolkit",
    agents: [{ id: "writer", name: "写手", description: null }],
  }),
});

const ALL = [adminView(), WITHDRAWN, WITHDRAWN_TEAM];

describe("插件市场管理面纯逻辑：范围口径与过滤", () => {
  // 四档计数：三档沿用浏览面口径，另加「已下架」（整包下架）。计数基于全量，不受关键词影响。
  test("管理面比浏览面多一档「已下架」的计数", () => {
    expect(countAdminScopes(ALL)).toEqual({ all: 3, teams: 2, connectors: 1, withdrawn: 2 });
  });

  // 「已下架」只收**整包**下架的条目：只撤下部分版本的条目仍是可见条目，它的水印在版本历史里。
  test("已下架档只收整包下架的条目", () => {
    expect(filterAdminPackages(ALL, "", "withdrawn").map((view) => view.slug)).toEqual([
      "acme-connector",
      "acme-toolkit",
    ]);
  });

  // 其余三档与浏览面同一份实现：下架与否不影响它们，否则「切到专家团队就少了几个包」会让人以为市场变了。
  test("其余三档沿用浏览面口径，与是否下架无关", () => {
    expect(filterAdminPackages(ALL, "", "all").map((view) => view.slug)).toEqual([
      "acme-team",
      "acme-connector",
      "acme-toolkit",
    ]);
    expect(filterAdminPackages(ALL, "", "teams").map((view) => view.slug)).toEqual(["acme-team", "acme-toolkit"]);
    expect(filterAdminPackages(ALL, "", "connectors").map((view) => view.slug)).toEqual(["acme-connector"]);
  });

  // 关键词与范围仍然是合取：已下架档里搜关键词同样要命中过滤，而不是把整批下架条目原样端出来。
  test("已下架档内关键词同样生效", () => {
    expect(filterAdminPackages(ALL, "toolkit", "withdrawn").map((view) => view.slug)).toEqual(["acme-toolkit"]);
  });
});

describe("插件市场管理面纯逻辑：冲突体解析", () => {
  const validPreview = {
    packageName: "@acme/toolkit",
    exactVersion: "2.0.1",
    metadataDigest: "sha256:abc",
    metadata: snapshot({ name: "@acme/toolkit", version: "2.0.1" }),
  };

  // 409 冲突体走的是**失败信封**（管理面 API 不做 unwrap）：`error.data.preview` 才是要渲染的新快照。
  test("从失败信封里取回刚读到的快照", () => {
    expect(readPreviewChangedPayload({ code: "PREVIEW_CHANGED", data: { preview: validPreview } })).toMatchObject({
      packageName: "@acme/toolkit",
      exactVersion: "2.0.1",
      metadataDigest: "sha256:abc",
    });
  });

  // 解析结果是**渲染子集**：落库字节（如 `metadataJson`）与其它协议字段不得混进来——面板只读白名单里的几个字段。
  test("解析结果只含渲染所需的字段", () => {
    const parsed = readPreviewChangedPayload({
      code: "PREVIEW_CHANGED",
      data: { preview: { ...validPreview, metadataJson: "{}", sourceId: "npm" } },
    });

    expect(Object.keys(parsed ?? {}).sort()).toEqual(["exactVersion", "metadata", "metadataDigest", "packageName"]);
  });

  // 形状不符时返回 null（页面按「预览不可用」处理）：不把半份数据画到界面上，也不因一个畸形响应炸掉整页。
  test("码不符或形状畸形时返回 null", () => {
    expect(readPreviewChangedPayload(undefined)).toBeNull();
    expect(readPreviewChangedPayload({ code: "INVALID_INPUT", data: { preview: validPreview } })).toBeNull();
    expect(readPreviewChangedPayload({ code: "PREVIEW_CHANGED" })).toBeNull();
    expect(readPreviewChangedPayload({ code: "PREVIEW_CHANGED", data: { preview: { packageName: "" } } })).toBeNull();
    expect(
      readPreviewChangedPayload({
        code: "PREVIEW_CHANGED",
        data: { preview: { packageName: "@a/b", exactVersion: "1.0.0", metadataDigest: "sha256:x" } },
      }),
    ).toBeNull();
  });
});

describe("插件市场管理面纯逻辑：写入结果提示", () => {
  // 四条文案各自独立，`noop` 尤其不能说「已发布」（用户需要知道这次点击没有产生新快照）。
  test("写入结果映射到各自的提示文案", () => {
    expect(changeToastKey("publish")).toBe("toast.published");
    expect(changeToastKey("noop")).toBe("toast.noop");
    expect(changeToastKey("unpublish")).toBe("toast.unpublished");
    expect(changeToastKey("restore")).toBe("toast.restored");
    // 服务端新增动作类型时不静默吞掉：落在最接近的中性口径上。
    expect(changeToastKey("unknown-action")).toBe("toast.published");
  });
});
