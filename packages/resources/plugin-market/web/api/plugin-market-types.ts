// plugin-market-types.ts — 插件市场的 `/web` 视图类型
//
// 这些类型**只描述后端真实返回的字段**（`src/server/routes/web/config/plugin-market-support.ts` 的四个
// 映射函数是唯一真相来源），前端不得添加任何后端没有的「幻影字段」：多一个字段就多一处只有前端相信的
// 状态，后端改契约时它不会报错、只会静默变成 undefined。
//
// 为什么放在 `web/api/` 而不是 `@fenix/web-runtime/types/config`：那份类型表是**跨包共享**的配置视图
// （mcp / skill / 模型 / 组织都用它），而市场条目只有本包的服务端与前端两面，放进去会让一个资源包的私有
// 形状进入所有包的公共契约面。依赖方向也因此是单向的：pages → api → 后端契约。

import type { ResourceAccessActions, ResourceScopeView } from "@fenix/web-runtime/types/config";

/**
 * 规范化快照（`src/server/npm-registry/types.ts` 的 `NormalizedPackageVersion` 的视图面）。
 *
 * 字段与快照逐条对应、不做派生：`isExpertTeam` 这类标记在服务端已经被刻意排除（见 `domain/package-view.ts`
 * 的说明），前端要展示「有没有成员」时直接读 `agents.length`。
 */
export interface PluginPackageMetadata {
  name: string;
  version: string;
  description: string | null;
  keywords: string[];
  displayName: string | null;
  summary: string | null;
  agents: { id: string; name: string; description: string | null }[];
  skills: { uri: string; name: string; description: string | null }[];
  servers: { id: string; transport: string; runtime: string | null }[];
  integrity: string | null;
  tarballUrl: string | null;
  unpackedSizeBytes: number | null;
  fileCount: number | null;
  deprecated: string | null;
  publishedAt: string | null;
}

/**
 * 市场条目视图。
 *
 * `scope` / `access` 与其它资源包同形（`ResourceAccessView`）：授权判断在服务端完成，前端只按
 * `access.actions` 做保守展示。`hidden` 表示整包下架——只有写权主体拿得到这类条目。
 */
export interface PluginPackageView {
  id: string;
  slug: string;
  sourceId: string;
  packageName: string;
  /** 最新可见版本；整包下架时为 null。 */
  latestVersion: string | null;
  /** 展示快照；快照坏损时为 null，展示层回退到包名。 */
  metadata: PluginPackageMetadata | null;
  /** 秒级时间戳（后端 `toEpochSeconds`）；无版本时为 null。0 是 1970 年，前端不得把 null 折成 0。 */
  publishedAt: number | null;
  hidden: boolean;
  scope?: ResourceScopeView;
  access?: { actions?: ResourceAccessActions };
}

/** 版本历史项；`unpublishedAt` 非空即下架水印。 */
export interface PluginPackageVersion {
  exactVersion: string;
  metadataDigest: string;
  firstPublishedAt: number | null;
  publishedAt: number | null;
  unpublishedAt: number | null;
  isLatest: boolean;
}

export interface PluginPackageDetailView extends PluginPackageView {
  versions: PluginPackageVersion[];
}

/**
 * 列表响应。
 *
 * `canPublish` 是**页面级能力位**，由服务端在同一写权探针上给出（`facade.list` 的说明）：前端据此决定
 * 「发布版本」入口是否出现。刻意不从 `packages` 里推导——市场为空时那会把管理员也判成只读，第一次发布
 * 就没有入口了。
 */
export interface PluginPackageListResult {
  packages: PluginPackageView[];
  total: number;
  canPublish: boolean;
}

/** 预览视图：不含落库字节（`metadataJson`），前端既不渲染它也不回传它。 */
export interface PluginPublicationPreview {
  packageName: string;
  exactVersion: string;
  metadata: PluginPackageMetadata;
  /** 「用户确认的是这一份内容」的凭据，随确认请求回传。 */
  metadataDigest: string;
}

/** 写入结果：只回「发生了什么」，列表要重新拉（顺序与展示快照都可能因这次写入而变）。 */
export interface PluginPublicationChange {
  action: string;
  slug: string;
  packageName: string;
  exactVersion: string;
}

/** 目录筛选口径：全部 / 专家团队（有 agent 成员）/ 连接器（有 MCP server 成员）/ 已下架。 */
export type PluginCatalogScope = "all" | "teams" | "connectors" | "withdrawn";
