// plugin-market-types.ts — 插件市场的 `/web` 视图类型（**浏览面**）
//
// 这些类型**只描述后端真实返回的字段**（`src/server/routes/plugin-market-support.ts` 的投影函数是唯一真相
// 来源），前端不得添加任何后端没有的「幻影字段」：多一个字段就多一处只有前端相信的状态，后端改契约时它不会
// 报错、只会静默变成 undefined。
//
// 浏览面是**纯浏览**：没有发布、下架与恢复的入口（管理动作只在管理台的插件市场页，走
// `./system-plugin-market-types.ts` 那一面）。因此这里没有逐行 `access`、没有恒为 false 的 `hidden`、也没有
// 版本级的 `unpublishedAt`——公开口径的条目与版本历史里根本不含它们，照搬过来只会留下没有消费方的字段。
//
// 管理面的视图类型单独一份（上引文件）：两条面是各自的协议投影，共用快照形状（{@link PluginPackageMetadata}）
// 而不共用条目与版本视图。
//
// 为什么放在 `web/api/` 而不是 `@fenix/web-runtime/types/config`：那份类型表是**跨包共享**的配置视图
// （mcp / skill / 模型 / 组织都用它），而市场条目只有本包的服务端与前端两面，放进去会让一个资源包的私有
// 形状进入所有包的公共契约面。依赖方向也因此是单向的：pages → api → 后端契约。

/**
 * 规范化快照（`src/server/npm-registry/types.ts` 的 `NormalizedPackageVersion` 的视图面）。
 *
 * 字段与快照逐条对应、不做派生：`isExpertTeam` 这类标记在服务端已经被刻意排除（见 `domain/package-view.ts`
 * 的说明），前端要展示「有没有成员」时直接读 `agents.length`。两条面共用这一份形状：快照是市场里冻结的
 * 同一份数据，不会因为看的人是谁而变。
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

/** 浏览面条目视图：市场里**对公众可见**的那些条目。 */
export interface PluginPackageView {
  id: string;
  slug: string;
  sourceId: string;
  packageName: string;
  /** 最新可见版本；条目只有一个空快照时为 null。 */
  latestVersion: string | null;
  /** 展示快照；快照坏损时为 null，展示层回退到包名。 */
  metadata: PluginPackageMetadata | null;
  /** 秒级时间戳（后端 `toEpochSeconds`）；无版本时为 null。0 是 1970 年，前端不得把 null 折成 0。 */
  publishedAt: number | null;
}

/**
 * 浏览面版本项。
 *
 * 没有 `unpublishedAt`：公开口径的版本历史只含可见版本，下架水印只在管理面出现
 * （`../server/routes/plugin-market-support.ts` 的 `toWebVersionItem` / `toSystemVersionItem`）。
 */
export interface PluginPackageVersion {
  exactVersion: string;
  metadataDigest: string;
  firstPublishedAt: number | null;
  publishedAt: number | null;
  isLatest: boolean;
}

export interface PluginPackageDetailView extends PluginPackageView {
  versions: PluginPackageVersion[];
}

/**
 * 列表响应。
 *
 * 没有页面级能力位（旧版的 `canPublish`）：浏览面没有任何写入口，「当前主体能否发布」在这里没有消费方。
 */
export interface PluginPackageListResult {
  packages: PluginPackageView[];
  total: number;
}

/** 目录筛选口径：全部 / 专家团队（有 agent 成员）/ 连接器（有 MCP server 成员）。 */
export type PluginCatalogScope = "all" | "teams" | "connectors";
