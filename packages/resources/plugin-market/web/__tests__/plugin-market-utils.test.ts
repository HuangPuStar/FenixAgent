// web/__tests__/plugin-market-utils.test.ts
// 插件市场**两条面共用**的展示层纯逻辑用例：过滤 / 计数 / 选中解析 / 展示取值 / 时间与体积格式化 / 授权失败判定。
//
// 这些都是「界面上看不见但错了很难反推」的判断：
// - 过滤把范围与关键词的合取写反，症状是「切到连接器仍然看到没有 MCP 成员的条目」；
// - 秒 / 毫秒换算写错一处（差 1000 倍），症状是发布时间显示成 1970 年或 5 万年以后；
// - 授权失败只认 403 而漏掉 401，症状是「凭据失效后页面停在原地反复重试」。
//
// 与 `plugin-market-admin-utils.test.ts` 的分工：管理面独有的一档范围口径与写路径产物（冲突体解析、提示映射）
// 在那边——这里只测对同一个条目给同一个答案的那些函数（参数取最小结构形状，两面的条目视图都满足它）。

import { describe, expect, test } from "bun:test";
import { ApiError } from "@fenix/web-runtime/api/request";
import type { PluginPackageView } from "../api/plugin-market-types";
import {
  countScopes,
  filterPackages,
  formatBytes,
  formatEpochSeconds,
  getPackageDisplayName,
  getPackageSummary,
  hasAgentMembers,
  hasServerMembers,
  isAccessDeniedCode,
  isUnauthorizedError,
  resolveSelectedPackage,
} from "../lib/plugin-market-utils";

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
    ...overrides,
  };
}

/** 只有 MCP 成员、没有 agent 成员：用来区分「连接器」与「专家团队」两档。 */
const CONNECTOR = packageView({
  id: "pkg-2",
  slug: "acme-connector",
  packageName: "@acme/connector",
  latestVersion: "0.9.0",
  metadata: {
    ...packageView().metadata!,
    name: "@acme/connector",
    version: "0.9.0",
    displayName: "行情连接器",
    summary: null,
    description: "行情 MCP 连接",
    keywords: ["行情"],
    agents: [],
  },
});

/** 声明了成员之外的字段都缺省：用来验证展示回退与空结果。 */
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

const ALL = [packageView(), CONNECTOR, PLAIN];

describe("插件市场纯逻辑：过滤与计数", () => {
  // 范围筛选按快照里的成员声明判定，不按条目其它字段猜：专家团队看 agents、连接器看 servers。
  test("范围筛选按成员声明命中", () => {
    expect(filterPackages(ALL, "", "teams").map((view) => view.slug)).toEqual(["acme-team"]);
    expect(filterPackages(ALL, "", "connectors").map((view) => view.slug)).toEqual(["acme-team", "acme-connector"]);
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
  // 公开口径只有三档：已下架的条目根本不在公开清单里，「已下架」是管理面独有的一档（见 admin-utils 用例）。
  test("各范围计数基于全量清单", () => {
    expect(countScopes(ALL)).toEqual({ all: 3, teams: 1, connectors: 2 });
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
    expect(resolveSelectedPackage(ALL, null)?.slug).toBe("acme-team");
  });

  // 选中项被过滤掉（切范围 / 改关键词）时同样回退：右侧不能停在一条已不在目录里的条目上。
  test("选中项被过滤掉时回退到第一条", () => {
    const filtered = filterPackages(ALL, "连接器", "all");

    expect(resolveSelectedPackage(filtered, "acme-team")?.slug).toBe("acme-connector");
  });

  // 过滤结果为空时返回 null（调用方走空状态），不是抛错也不是拿全量里的第一条。
  test("过滤结果为空时返回 null", () => {
    expect(resolveSelectedPackage(filterPackages(ALL, "不存在的关键词", "all"), "acme-team")).toBeNull();
    expect(resolveSelectedPackage([], null)).toBeNull();
  });
});

describe("插件市场纯逻辑：展示取值与格式化", () => {
  // 展示名与说明各有回退：展示名缺 → 包名；summary 缺 → description；两者都缺 → null（调用方给「暂无说明」）。
  test("展示名与说明的回退顺序", () => {
    expect(getPackageDisplayName(PLAIN)).toBe("@acme/toolkit");
    expect(getPackageSummary(CONNECTOR)).toBe("行情 MCP 连接");
    expect(getPackageSummary(PLAIN)).toBeNull();
  });

  // 后端给秒、格式化原语吃毫秒：换算只在这一处发生。断言到年份即可证明量级正确（差 1000 倍会偏到 1970 或 5 万年）。
  test("秒级时间戳换算成毫秒后格式化", () => {
    expect(formatEpochSeconds(1_767_225_600, "zh-CN")).toContain("2026");
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
});

describe("插件市场纯逻辑：授权失败判定", () => {
  // 授权失败的两个码都要认：403（无权）与 401（缺组织上下文）对界面是同一个结论——不给重试。
  test("授权失败错误码识别", () => {
    expect(isUnauthorizedError(new ApiError("禁止", "FORBIDDEN"))).toBe(true);
    expect(isUnauthorizedError(new ApiError("未认证", "UNAUTHORIZED"))).toBe(true);
    expect(isUnauthorizedError(new ApiError("未找到", "NOT_FOUND"))).toBe(false);
    expect(isUnauthorizedError(new Error("普通错误"))).toBe(false);
    expect(isUnauthorizedError(null)).toBe(false);
  });

  // 信封层判定独立于 `instanceof`：管理面的写路径拿到的是失败响应体（`{ code }`），不是 `ApiError`。
  // 两层各司其职——写路径若只用 `isUnauthorizedError`，key 失效会被当成普通失败，人停在原地反复点。
  test("失败信封里的授权码也能判定", () => {
    expect(isAccessDeniedCode("FORBIDDEN")).toBe(true);
    expect(isAccessDeniedCode("UNAUTHORIZED")).toBe(true);
    expect(isAccessDeniedCode("NOT_FOUND")).toBe(false);
    expect(isAccessDeniedCode(undefined)).toBe(false);
  });
});
