/**
 * npm 私有源读取结果的白名单快照契约。
 *
 * **这是一条安全边界，不是一个数据形状**：快照是「registry 的不可信 JSON」与「市场自己的可信存储」之间
 * 唯一的过桥形式。原始 packument 与任何未列入本文件的字段**永远不进市场存储**，因此本文件同时是「哪些
 * 内容可以离开外部源」的清单——新增字段必须先回答它是否会被外部源控制，以及它会不会成为任意文本的载体。
 *
 * 相对源项目（`packages/mcp-market/src/npm-registry/types.ts`）的差异只有「删掉第二来源的字段」，没有新增：
 * - `SnapshotTool` / `SnapshotResource` / `SnapshotResourceTemplate` / `SnapshotPrompt` /
 *   `SnapshotCapabilities` / `serverInfo` / `sourceKind` / `SnapshotServer.endpoint`：全部由
 *   `http-source`（MCP over HTTP 发现客户端）产出，不在本期范围；它们的消费点也只存在于 HTTP 源的管理
 *   页面与详情页。留下它们会让快照契约声称「本模块能装下 HTTP 源的内容」，而实际没有任何产出点。
 * - `NormalizedPackageVersion.skills` 由可选改为必填：源项目标它是可选，是因为它的 SQLite 表里存在
 *   「skills 出现之前写入的旧行」；本模块是新建表、没有存量行，保持可选只会让每个消费点都写一遍
 *   `skills ?? []`。
 */

/** 一个 agent 成员。`id` 在同一个包内唯一，由 `normalize` 保证。 */
export type SnapshotAgent = {
  id: string;
  name: string;
  description: string | null;
};

/**
 * package 级 Skills 发现元数据。
 *
 * `uri` 只接受 `skill://<路径>/SKILL.md` 形状：它是**引用**而不是内容，市场既不抓取也不缓存技能正文，
 * 因此不允许 `http(s)://`（那会把市场变成任意 URL 的转发器）。
 */
export type SnapshotSkill = {
  uri: string;
  name: string;
  description: string | null;
};

/** 一个 MCP server 成员。`transport` / `runtime` 都是自由声明文本，不含连接凭据。 */
export type SnapshotServer = {
  id: string;
  transport: string;
  runtime: string | null;
};

/**
 * 一个 npm 包的精确版本的规范化快照。
 *
 * `tarballUrl` 只作**溯源记录**：市场永不请求它（§「永不请求 tarball」），前端只以纯文本展示，
 * 因此它不是一条可达的请求路径。
 */
export type NormalizedPackageVersion = {
  name: string;
  version: string;
  description: string | null;
  keywords: string[];
  displayName: string | null;
  summary: string | null;
  agents: SnapshotAgent[];
  skills: SnapshotSkill[];
  servers: SnapshotServer[];
  /** Subresource Integrity：`<algo>-<base64>`，来源是包的 `dist.integrity`。 */
  integrity: string | null;
  /** 仅供溯源展示；永不请求。 */
  tarballUrl: string | null;
  unpackedSizeBytes: number | null;
  fileCount: number | null;
  deprecated: string | null;
  /** 取 packument 的 `time[exactVersion]`；缺失或非法时为 null（不臆造日期）。 */
  publishedAt: string | null;
};

/** 一次「精确版本」读取请求的身份三元组。 */
export type PackageVersionRef = {
  sourceId: string;
  packageName: string;
  exactVersion: string;
};

/**
 * 预览结果：快照 + 其序列化形式 + 摘要。
 *
 * 三个字段一起返回而不是只给 `metadata`：`metadataJson` 是**落库的字节原文**，`metadataDigest` 是它的
 * 哈希。落库保存 `metadataJson` 而不是重新 `JSON.stringify(metadata)`，是为了让「存储的摘要 ≡ 存储的
 * 内容」永远成立——任何一侧重算都可能因键序或浮点格式化差异而失配。
 */
export type PublicationPreview = {
  ref: PackageVersionRef;
  metadata: NormalizedPackageVersion;
  metadataJson: string;
  metadataDigest: string;
};
