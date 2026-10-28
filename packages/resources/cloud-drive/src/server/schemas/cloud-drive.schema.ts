import { WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";

/**
 * `/web/cloud-drive/*` 的协议模型（请求体、查询、参数与响应 DTO）。
 *
 * 这里的 DTO 是 Fenix 自己的契约，不是 CloudDrive 的线上形状：上游 `to_jsonb` 直接返回表行
 * （`owner_id` / `space_id` / `native_*` / `reserved_location` 等内部字段），本层把它们排除并改成
 * camelCase（转换在 `../client/cloud-drive-mappers`）。前端因此拿不到、也不依赖 CloudDrive 的内部
 * 标识；上游新增列不会自动出现在 Fenix 响应里。
 */

/** CloudDrive 资源 ID（file / upload / trash）。上游为 UUID；限制字符集同时阻断路径穿越。 */
export const CloudDriveResourceIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/, "非法的 CloudDrive 资源 ID")
  .describe("CloudDrive 资源 ID。");

/**
 * 文件名。
 *
 * 规则与 CloudDrive 的 `ValidateName` 对齐（NFC 归一由上游完成）：非空、≤255、不含 `/` `\`、
 * 不是 `.` / `..`、不含控制字符。提前拒绝让用户得到 400，而不是把上游的 `INVALID_PATH` 变成 502。
 */
export const CloudDriveFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value !== "." && value !== "..", "文件名不能是 . 或 ..")
  .refine((value) => !value.includes("/") && !value.includes("\\"), "文件名不能包含路径分隔符")
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 控制字符正是要拒绝的输入
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "文件名不能包含控制字符")
  .describe("文件名（不含路径分隔符，长度 ≤ 255）。");

/** 条目类型。 */
export const CloudDriveKindSchema = z.enum(["file", "directory"]).describe("条目类型：文件或目录。");

/** 条目生命周期；`active` 之外的状态对前端只读。 */
export const CloudDriveLifecycleSchema = z
  .enum(["active", "deleting", "trashed", "restoring"])
  .describe("条目生命周期状态。");

/** 转换任务摘要；未发起转换时整个字段为 null。 */
export const CloudDriveConversionSchema = z.object({
  status: z.string().nullable().describe("转换状态；上游未返回时为 null。"),
  errorCode: z.string().nullable().describe("转换失败码；无失败时为 null。"),
  completeness: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe("产物完整度（仅元数据接口返回，列表接口为 null）。"),
});

/** 文件或目录的元数据。 */
export const CloudDriveFileSchema = z.object({
  id: CloudDriveResourceIdSchema,
  parentId: CloudDriveResourceIdSchema.nullable().describe("父目录 ID；根目录下的条目为 null。"),
  name: z.string().describe("条目名。"),
  path: z.string().describe("业务绝对路径，以 / 开头。"),
  kind: CloudDriveKindSchema,
  lifecycle: CloudDriveLifecycleSchema,
  sizeBytes: z.number().int().nonnegative().describe("当前版本字节数；目录为 0。"),
  contentType: z.string().describe("内容类型；目录为 application/octet-stream。"),
  currentVersionId: z.string().nullable().describe("当前版本 ID；目录为 null。"),
  metadataRevision: z.number().int().positive().describe("元数据修订号；改名/移动/删除的乐观并发依据。"),
  createdAt: z.string().nullable().describe("创建时间（RFC3339）；上游未返回时为 null。"),
  updatedAt: z.string().nullable().describe("更新时间（RFC3339）；上游未返回时为 null。"),
  conversion: CloudDriveConversionSchema.nullable(),
});

/** 文件列表的一页。 */
export const CloudDriveFilePageSchema = z.object({
  items: z.array(CloudDriveFileSchema),
  nextCursor: z.string().nullable().describe("下一页游标；没有更多时为 null。"),
});

/** 历史版本。 */
export const CloudDriveVersionSchema = z.object({
  id: z.string().describe("版本 ID。"),
  fileId: z.string().describe("所属文件 ID。"),
  versionSeq: z.number().int().positive().describe("版本序号（从 1 递增）。"),
  sizeBytes: z.number().int().nonnegative().describe("该版本字节数。"),
  contentType: z.string().describe("该版本内容类型。"),
  committedAt: z.string().nullable().describe("提交时间（RFC3339）。"),
  conversionStatus: z.string().nullable().describe("该版本的转换状态；未发起转换时为 null。"),
});

/** 版本列表。 */
export const CloudDriveVersionPageSchema = z.object({
  items: z.array(CloudDriveVersionSchema),
});

/** 回收站条目；`file` 是根条目的当前（已删除）元数据。 */
export const CloudDriveTrashEntrySchema = z.object({
  id: CloudDriveResourceIdSchema,
  rootFileId: z.string().describe("被删除的根条目 ID。"),
  originalParentId: z.string().nullable().describe("删除前所在目录；根目录为 null。"),
  originalName: z.string().describe("删除前名称。"),
  originalPath: z.string().describe("删除前业务路径。"),
  deletedAt: z.string().nullable().describe("删除时间（RFC3339）。"),
  restoredAt: z.string().nullable().describe("恢复时间（RFC3339）；未恢复为 null。"),
  state: z.string().describe("回收站状态：deleting / trashed / restoring / restored / failed_confirmed。"),
  file: CloudDriveFileSchema,
});

/** 回收站列表。 */
export const CloudDriveTrashPageSchema = z.object({
  items: z.array(CloudDriveTrashEntrySchema),
});

/** 搜索命中。 */
export const CloudDriveSearchHitSchema = z.object({
  fileId: z.string().describe("命中文件 ID。"),
  path: z.string().describe("命中文件的业务路径。"),
  snippet: z.string().describe("命中片段。"),
  location: z.object({
    page: z.number().nullable().describe("页码；无页码信息时为 null。"),
    block: z.string().nullable().describe("块标识；无块信息时为 null。"),
  }),
  completeness: z.object({
    status: z.string().nullable().describe("产物完整度状态。"),
    missingTextPages: z.unknown().nullable().describe("缺失文本的页码列表（上游原样返回）。"),
  }),
  stale: z.boolean().describe("命中版本是否已落后于当前版本。"),
  currentVersionId: z.string().nullable().describe("文件当前版本 ID。"),
  returnedVersionId: z.string().nullable().describe("命中所在的版本 ID。"),
  newerVersionStatus: z.string().nullable().describe("更新版本的转换状态；无更新版本时为 null。"),
});

/** 搜索结果一页。最终一致：刚写入的文件可能暂时搜不到。 */
export const CloudDriveSearchPageSchema = z.object({
  items: z.array(CloudDriveSearchHitSchema),
  nextCursor: z.string().nullable().describe("下一页游标；没有更多时为 null。"),
});

/** 当前主体与配额。 */
export const CloudDrivePrincipalSchema = z.object({
  subject: z.string().describe("CloudDrive 侧的稳定主体标识（即当前 Fenix 用户 ID）。"),
  quota: z.object({
    limitBytes: z.number().int().nonnegative().describe("配额上限（字节）。"),
    usedBytes: z.number().int().nonnegative().describe("已用字节数。"),
    reservedBytes: z.number().int().nonnegative().describe("上传中预留字节数。"),
    updatedAt: z.string().nullable().describe("配额最近更新时间（RFC3339）。"),
  }),
});

/** 变更类动作（建目录 / 改名 / 移动 / 删除 / 恢复）的结果。 */
export const CloudDriveMutationSchema = z.object({
  operationId: z.string().describe("CloudDrive 操作 ID，可用于排查。"),
  fileId: z.string().describe("目标条目 ID。"),
  state: z
    .enum(["prepared", "executing", "outcome_unknown", "remote_confirmed", "committed", "failed_confirmed"])
    .describe("操作状态；非 committed 表示尚未落定。"),
  errorCode: z.string().nullable().describe("失败码；成功时为 null。"),
  compensated: z.boolean().describe("上游是否已执行补偿回滚。"),
  message: z.string().nullable().describe("补偿时的提示文案；无补偿时为 null。"),
  file: CloudDriveFileSchema.nullable().describe("操作已提交时返回目标条目最新元数据。"),
});

/** 上传会话。刻意不含 `upload_url`：前端只能经 Fenix 的 `/web/cloud-drive/uploads/:id` 续传。 */
export const CloudDriveUploadSchema = z.object({
  uploadId: z.string().describe("上传会话 ID（同时用于 /uploads/:id 的续传与提交）。"),
  fileId: z.string().describe("目标文件 ID（新建时由 CloudDrive 预分配）。"),
  operationId: z.string().describe("上传操作 ID。"),
  status: z.string().describe("上传状态，如 uploading。"),
  expiresAt: z.string().nullable().describe("会话过期时间（RFC3339）；过期策略以 CloudDrive 部署为准。"),
});

/** 上传会话的当前进度。 */
export const CloudDriveUploadStatusSchema = z.object({
  uploadId: z.string().describe("上传会话 ID。"),
  offset: z.number().int().nonnegative().describe("已接收字节数；续传时必须作为 Upload-Offset 发送。"),
  length: z.number().int().nonnegative().describe("预留总字节数（创建上传会话时的 sizeBytes）。"),
});

/** 提交上传的结果。 */
export const CloudDriveUploadResultSchema = z.object({
  fileId: z.string().describe("已保存的文件 ID。"),
  versionId: z.string().describe("新版本 ID。"),
  status: z.string().describe("提交状态，例如 saved。"),
});

/** 放弃上传的结果。 */
export const CloudDriveAbandonResultSchema = z.object({
  uploadId: z.string().describe("被放弃的上传会话 ID。"),
  fileId: z.string().describe("目标文件 ID。"),
  status: z.string().describe("状态，例如 abandoned。"),
});

/* ── 请求模型 ─────────────────────────────────────── */

/** 单个资源路径参数（file / upload / trash 共用）。 */
export const CloudDriveFileParamsSchema = z.object({ id: CloudDriveResourceIdSchema });
export const CloudDriveUploadParamsSchema = z.object({ id: CloudDriveResourceIdSchema });
export const CloudDriveTrashParamsSchema = z.object({ id: CloudDriveResourceIdSchema });

/** `GET /files` 的查询参数。 */
export const CloudDriveListFilesQuerySchema = z.object({
  parentId: CloudDriveResourceIdSchema.optional().describe("父目录 ID；省略表示根目录。"),
  cursor: z.string().max(4096).optional().describe("上一页返回的 nextCursor。"),
});

/** `GET /files/:id/content` 的查询参数。 */
export const CloudDriveContentQuerySchema = z.object({
  versionId: z.string().max(200).optional().describe("下载指定历史版本；省略表示当前版本。"),
});

/** 下载接口透传的请求头。CloudDrive 只支持单个字节区间，多段 Range 会返回 416。 */
export const CloudDriveContentHeadersSchema = z.object({
  range: z.string().max(200).optional().describe("单个字节区间，如 bytes=0-1023；不支持多段与后缀区间。"),
});

/** 新建目录。 */
export const CreateCloudDriveDirectoryBodySchema = z.object({
  name: CloudDriveFileNameSchema,
  parentId: CloudDriveResourceIdSchema.nullable().optional().describe("父目录 ID；省略或 null 表示根目录。"),
});

/** 改名 / 移动。两项至少给一个；`parentId: null` 表示移动到根目录。 */
export const MoveCloudDriveFileBodySchema = z
  .object({
    name: CloudDriveFileNameSchema.optional(),
    parentId: CloudDriveResourceIdSchema.nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.parentId !== undefined, {
    message: "name 与 parentId 至少提供一项",
  });

/** 从回收站恢复。`expectedMetadataRevision` 取自回收站条目的 `file.metadataRevision`。 */
export const RestoreCloudDriveTrashBodySchema = z.object({
  expectedMetadataRevision: z.number().int().min(1).describe("回收站条目当前元数据修订号（乐观并发校验）。"),
  parentId: CloudDriveResourceIdSchema.nullable().optional().describe("恢复到指定目录；省略表示原目录。"),
  name: CloudDriveFileNameSchema.optional().describe("恢复后的名称；省略表示原名。"),
});

/** 搜索。 */
export const SearchCloudDriveBodySchema = z.object({
  query: z.string().min(1).max(1000).describe("搜索词。"),
  cursor: z.string().max(4096).optional().describe("上一页返回的 nextCursor。"),
  limit: z.number().int().min(1).max(100).optional().describe("每页条数，1-100，默认 20。"),
});

/**
 * 创建上传会话。
 *
 * `fileId` 存在表示覆盖写：Facade 会先读取当前元数据，用其 `currentVersionId` 与
 * `metadataRevision` 做乐观并发校验；覆盖写不允许改名或移动。新建时 `name` 必填。
 */
export const BeginCloudDriveUploadBodySchema = z
  .object({
    fileId: CloudDriveResourceIdSchema.optional().describe("覆盖写目标文件 ID；新建时省略。"),
    parentId: CloudDriveResourceIdSchema.nullable().optional().describe("目标目录；省略或 null 表示根目录。"),
    name: CloudDriveFileNameSchema.optional().describe("文件名；覆盖写时省略，且不得与原名称不同。"),
    sizeBytes: z.number().int().nonnegative().describe("文件总字节数；分片总长不得超过该值。"),
    contentType: z.string().min(1).max(255).optional().describe("内容类型，默认 application/octet-stream。"),
  })
  .refine((value) => value.fileId !== undefined || value.name !== undefined, {
    message: "新建上传必须提供 name",
  });

/** 上传分片大小建议值：CloudDrive 单请求上限 64MiB，宿主全站 body 上限 108MiB，4MiB 留足余量。 */
export const CLOUD_DRIVE_RECOMMENDED_CHUNK_BYTES = 4 * 1024 * 1024;

/* ── 响应信封 ─────────────────────────────────────── */

export const CloudDriveMeResponseSchema = WebOkSchema(CloudDrivePrincipalSchema).describe("个人云盘主体与配额。");
export const CloudDriveFilePageResponseSchema = WebOkSchema(CloudDriveFilePageSchema).describe("目录列表一页。");
export const CloudDriveFileResponseSchema = WebOkSchema(CloudDriveFileSchema).describe("单个条目元数据。");
export const CloudDriveVersionPageResponseSchema =
  WebOkSchema(CloudDriveVersionPageSchema).describe("文件历史版本列表。");
export const CloudDriveTrashPageResponseSchema = WebOkSchema(CloudDriveTrashPageSchema).describe("回收站条目列表。");
export const CloudDriveSearchPageResponseSchema = WebOkSchema(CloudDriveSearchPageSchema).describe("搜索结果一页。");
export const CloudDriveMutationResponseSchema = WebOkSchema(CloudDriveMutationSchema).describe("变更动作的结果。");
export const CloudDriveUploadResponseSchema = WebOkSchema(CloudDriveUploadSchema).describe("已创建的上传会话。");
export const CloudDriveUploadStatusResponseSchema =
  WebOkSchema(CloudDriveUploadStatusSchema).describe("上传会话当前进度。");
export const CloudDriveUploadResultResponseSchema = WebOkSchema(CloudDriveUploadResultSchema).describe("上传已提交。");
export const CloudDriveAbandonResponseSchema = WebOkSchema(CloudDriveAbandonResultSchema).describe("上传已放弃。");

/* ── 类型 ─────────────────────────────────────────── */

export type CloudDriveConversion = z.infer<typeof CloudDriveConversionSchema>;
export type CloudDriveFile = z.infer<typeof CloudDriveFileSchema>;
export type CloudDriveFilePage = z.infer<typeof CloudDriveFilePageSchema>;
export type CloudDriveVersion = z.infer<typeof CloudDriveVersionSchema>;
export type CloudDriveVersionPage = z.infer<typeof CloudDriveVersionPageSchema>;
export type CloudDriveTrashEntry = z.infer<typeof CloudDriveTrashEntrySchema>;
export type CloudDriveTrashPage = z.infer<typeof CloudDriveTrashPageSchema>;
export type CloudDriveSearchHit = z.infer<typeof CloudDriveSearchHitSchema>;
export type CloudDriveSearchPage = z.infer<typeof CloudDriveSearchPageSchema>;
export type CloudDrivePrincipal = z.infer<typeof CloudDrivePrincipalSchema>;
export type CloudDriveMutation = z.infer<typeof CloudDriveMutationSchema>;
export type CloudDriveUpload = z.infer<typeof CloudDriveUploadSchema>;
export type CloudDriveUploadStatus = z.infer<typeof CloudDriveUploadStatusSchema>;
export type CloudDriveUploadResult = z.infer<typeof CloudDriveUploadResultSchema>;
export type CloudDriveAbandonResult = z.infer<typeof CloudDriveAbandonResultSchema>;
