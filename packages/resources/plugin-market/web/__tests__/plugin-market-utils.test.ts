// web/__tests__/plugin-market-utils.test.ts
// 插件市场目录页纯逻辑的用例：过滤 / 计数 / 选中解析 / 展示取值 / 动作可见性 / 时间与体积格式化 /
// 冲突体解析 / 结果提示映射。
//
// 这些都是「界面上看不见但错了很难反推」的判断：
// - 过滤把范围与关键词的合取写反，症状是「切到连接器仍然看到没有 MCP 成员的条目」；
// - 秒 / 毫秒换算写错一处（差 1000 倍），症状是发布时间显示成 1970 年或 5 万年以后；
// - 409 冲突体解析只接 `ApiError` 而实际拿到的是失败信封，症状是「点了确认没反应」。

import { describe, expect, test } from "bun:test";
import { ApiError } from "@fenix/web-runtime/api/request";
import type { PluginPackageView, PluginPublicationPreview } from "../api/plugin-market-types";
import {
  canWritePackage,
  changeToastKey,
  countScopes,
  filterPackages,
  formatBytes,
  formatEpochSeconds,
  getPackageDisplayName,
  getPackageSummary,
  hasAgentMembers,
  hasServerMembers,
  isUnauthorizedError,
  readPreviewChangedPayload,
  resolveSelectedPackage,
} from "../pages/agent-panel/pages/plugin-market-utils";

/** 构造一个最小条目视图；只覆盖断言用到的字段，其余给中性默认值。 */
function packageView(overrides: Partial<PluginPackageView> = {}): PluginPackageView {
  return {
    id: "pkg-1",
    slug: "acme-team",
    sourceId: "npm",
    packageName: "@acme/investment-team",
    latestVersion: "1.2.0",
    metadata: {
      name: "@acme/investment-team",
      version: "1.2.0",
      description: "投研专家团队",
      keywords: ["投资", "research"],
      displayName: "投研团队",
      summary: "面向二级市场的投研 Agent 团队",
      agents: [{ id: "analyst", name: "分析师", description: "基本面分析" }],
      skills: [{ uri: "skill://acme/research/SKILL.md", name: "研究", description: null }],
      servers: [{ id: "market-data", transport: "stdio", runtime: "bun" }],
      integrity: null,
      tarballUrl: null,
      unpackedSizeBytes: null,
      fileCount: null,
      deprecated: null,
      publishedAt: null,
    },
    publishedAt: 1_767_225_600,
    hidden: false,
    ...overrides,
  };
}

const WITHDRAWN = packageView({
  id: "pkg-2",
  slug: "acme-connector",
  packageName: "@acme/connector",
  latestVersion: null,
  hidden: true,
  metadata: {
    ...packageView().metadata!,
    name: "@acme/connector",
    version: "0.9.0",
    displayName: "行情连接器",
    summary: null,
    description: "行情 MCP 连接",
    keywords: ["行情"],
    agents: [],
    skills: [],
  },
});

const PLAIN = packageView({
  id: "pkg-3",
  slug: "acme-toolkit",
  packageName: "@acme/toolkit",
  latestVersion: "2.0.0",
  metadata: {
    ...packageView().metadata!,
    name: "@acme/toolkit",
    version: "2.0.0",
    displayName: null,
    summary: null,
    description: null,
    keywords: [],
    agents: [],
    servers: [],
  },
});

const ALL = [packageView(), WITHDRAWN, PLAIN];

describe("插件市场纯逻辑：过滤与计数", () => {
  // 范围筛选按快照里的成员声明判定，不按条目其它字段猜：专家团队看 agents、连接器看 servers。
  test("范围筛选按成员声明命中", () => {
    expect(filterPackages(ALL, "", "teams").map((view) => view.slug)).toEqual(["acme-team"]);
    expect(filterPackages(ALL, "", "connectors").map((view) => view.slug)).toEqual(["acme-team", "acme-connector"]);
    expect(filterPackages(ALL, "", "withdrawn").map((view) => view.slug)).toEqual(["acme-connector"]);
    expect(filterPackages(ALL, "", "all")).toHaveLength(3);
  });

  // 关键词与范围是**合取**：切到某个范围后再搜关键词，两个条件是同时生效的。
  test("关键词与范围是合取关系", () => {
    expect(filterPackages(ALL, "连接器", "all").map((view) => view.slug)).toEqual(["acme-connector"]);
    expect(filterPackages(ALL, "连接器", "teams")).toEqual([]);
  });

  // 匹配面要够宽：包名、展示名、当前版本号、说明与关键词任一命中都算（用户记得住哪一个都能搜到）。
  test("关键词匹配包名、展示名、版本、说明与关键词", () => {
    expect(filterPackages(ALL, "@acme/toolkit", "all").map((view) => view.slug)).toEqual(["acme-toolkit"]);
    expect(filterPackages(ALL, "投研团队", "all").map((view) => view.slug)).toEqual(["acme-team"]);
    expect(filterPackages(ALL, "2.0.0", "all").map((view) => view.slug)).toEqual(["acme-toolkit"]);
    expect(filterPackages(ALL, "行情", "all").map((view) => view.slug)).toEqual(["acme-connector"]);
    expect(filterPackages(ALL, "research", "all").map((view) => view.slug)).toEqual(["acme-team"]);
  });

  // 关键词大小写与首尾空白都不影响结果：搜索框里的输入不做格式要求。
  test("关键词忽略大小写与首尾空白", () => {
    expect(filterPackages(ALL, "  ACME/TOOLKIT  ", "all").map((view) => view.slug)).toEqual(["acme-toolkit"]);
  });

  // 计数是筛选条上的徽标：它统计**全量**（不受当前关键词影响），否则切范围时数字会随输入跳动。
  test("各范围计数基于全量清单", () => {
    expect(countScopes(ALL)).toEqual({ all: 3, teams: 1, connectors: 2, withdrawn: 1 });
  });

  // 元数据坏损（快照解析失败）时视图给 null：成员判定必须落在「没有成员」而不是抛错。
  test("元数据缺失时成员判定为假", () => {
    const broken = packageView({ metadata: null });

    expect(hasAgentMembers(broken)).toBe(false);
    expect(hasServerMembers(broken)).toBe(false);
    expect(getPackageDisplayName(broken)).toBe("@acme/investment-team");
    expect(getPackageSummary(broken)).toBeNull();
  });
});

describe("插件市场纯逻辑：选中项解析", () => {
  // 未选中时回退到第一条：进入页面就有内容，不需要用户先点一下。
  test("未选中时回退到过滤结果的第一条", () => {
    expect(resolveSelectedPackage(ALL, "", "all", null)?.slug).toBe("acme-team");
  });

  // 选中项被过滤掉（切范围 / 改关键词）时同样回退：右侧不能停在一条已不在目录里的条目上。
  test("选中项被过滤掉时回退到第一条", () => {
    expect(resolveSelectedPackage(ALL, "", "withdrawn", "acme-team")?.slug).toBe("acme-connector");
  });

  // 过滤结果为空时返回 null（调用方走空状态），不是抛错也不是拿全量里的第一条。
  test("过滤结果为空时返回 null", () => {
    expect(resolveSelectedPackage(ALL, "不存在的关键词", "all", "acme-team")).toBeNull();
    expect(resolveSelectedPackage([], "", "all", null)).toBeNull();
  });
});

describe("插件市场纯逻辑：动作可见性与展示取值", () => {
  // 写动作按服务端给的 `access.actions` 保守判断：没有 update 就不给按钮（不给「大概可以」的猜测）。
  test("写动作按 access.update 判定", () => {
    expect(canWritePackage(packageView({ access: { actions: ["read", "update"] } }))).toBe(true);
    expect(canWritePackage(packageView({ access: { actions: ["read"] } }))).toBe(false);
    expect(canWritePackage(packageView({ access: {} }))).toBe(false);
    expect(canWritePackage(packageView())).toBe(false);
  });

  // 展示名与说明各有回退：展示名缺 → 包名；summary 缺 → description；两者都缺 → null（调用方给「暂无说明」）。
  test("展示名与说明的回退顺序", () => {
    expect(getPackageDisplayName(PLAIN)).toBe("@acme/toolkit");
    expect(getPackageSummary(WITHDRAWN)).toBe("行情 MCP 连接");
    expect(getPackageSummary(PLAIN)).toBeNull();
  });
});

describe("插件市场纯逻辑：格式化与冲突解析", () => {
  // 后端给秒、格式化原语吃毫秒：换算只在这一处发生。断言到年份即可证明量级正确（差 1000 倍会偏到 1970 或 5 万年）。
  test("秒级时间戳换算成毫秒后格式化", () => {
    const formatted = formatEpochSeconds(1_767_225_600, "zh-CN");

    expect(formatted).toContain("2026");
  });

  // null 不折成 0：0 是 1970 年，会让「没有值」显示成一个真实时刻。
  test("空时刻回退到占位符", () => {
    expect(formatEpochSeconds(null, "zh-CN")).toBe("—");
  });

  // 体积：缺值与非正数不渲染（返回 null），1 MiB 以下用 KiB、以上用 MiB。
  test("体积按量级选择单位，缺值返回 null", () => {
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(0)).toBeNull();
    expect(formatBytes(2048, "en")).toContain("2");
    expect(formatBytes(3 * 1024 * 1024, "en")).toContain("3");
  });

  // 写入结果提示：四条文案各自独立，`noop` 尤其不能说「已发布」（用户需要知道这次点击没有产生新快照）。
  test("写入结果映射到各自的提示文案", () => {
    expect(changeToastKey("publish")).toBe("toast.published");
    expect(changeToastKey("noop")).toBe("toast.noop");
    expect(changeToastKey("unpublish")).toBe("toast.unpublished");
    expect(changeToastKey("restore")).toBe("toast.restored");
    // 服务端新增动作类型时不静默吞掉：落在中性口径上。
    expect(changeToastKey("unknown-action")).toBe("toast.published");
  });

  // 授权失败的两个码都要认：403（无权）与 401（缺组织上下文）对界面是同一个结论——不给重试。
  test("授权失败错误码识别", () => {
    expect(isUnauthorizedError(new ApiError("禁止", "FORBIDDEN"))).toBe(true);
    expect(isUnauthorizedError(new ApiError("未认证", "UNAUTHORIZED"))).toBe(true);
    expect(isUnauthorizedError(new ApiError("未找到", "NOT_FOUND"))).toBe(false);
    expect(isUnauthorizedError(new Error("普通错误"))).toBe(false);
    expect(isUnauthorizedError(null)).toBe(false);
  });

  // 409 冲突体走的是**失败信封**（本域 API 不做 unwrap）：`error.data.preview` 才是要渲染的新快照。
  test("409 冲突体解析出新快照", () => {
    const preview: PluginPublicationPreview = {
      packageName: "@acme/toolkit",
      exactVersion: "2.0.1",
      metadataDigest: "sha256:abc",
      metadata: {
        ...packageView().metadata!,
        name: "@acme/toolkit",
        version: "2.0.1",
        displayName: "工具箱",
      },
    };

    expect(readPreviewChangedPayload({ code: "PREVIEW_CHANGED", data: { preview } })).toMatchObject({
      exactVersion: "2.0.1",
      metadataDigest: "sha256:abc",
    });
  });

  // 形状不符时返回 null（页面按「预览不可用」处理）：不把半份数据画到界面上，也不因一个畸形响应炸掉整页。
  test("冲突体畸形或码不符时返回 null", () => {
    expect(readPreviewChangedPayload(undefined)).toBeNull();
    expect(readPreviewChangedPayload({ code: "INVALID_INPUT", data: {} })).toBeNull();
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
