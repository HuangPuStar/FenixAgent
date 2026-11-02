import * as z from "zod/v4";

/**
 * CloudDrive REST 的线上响应形状（snake_case）。
 *
 * 只声明本模块实际读取的字段，且全部是**非 strict** 对象：上游新增列不会让解析失败，也不会自动出现在
 * Fenix 响应里（DTO 由 `cloud-drive-mappers` 重新构造）。写在这里而不是散落在 client 方法里，是为了
 * 让「我们依赖上游哪些字段」只有一份清单。
 */

const NullableString = z.string().nullish();

/** 转换摘要：列表只带 status/error_code，元数据接口额外带 completeness。 */
const WireConversionSchema = z
  .object({
    status: NullableString,
    error_code: NullableString,
    completeness: z.record(z.string(), z.unknown()).nullish(),
  })
  .nullish();

/** `files` 行的投影（`to_jsonb(f)` 去掉 native_* 与 active_operation_id 后加上 size_bytes/conversion）。 */
export const WireFileSchema = z.object({
  id: z.string(),
  parent_id: NullableString,
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "directory"]),
  lifecycle: z.enum(["active", "deleting", "trashed", "restoring"]),
  metadata_revision: z.number(),
  size: z.number().nullish(),
  size_bytes: z.number().nullish(),
  content_type: NullableString,
  current_version_id: NullableString,
  created_at: NullableString,
  updated_at: NullableString,
  conversion: WireConversionSchema,
});

/** `GET /v1/files` 与 `GET /v1/search` 共用的游标分页信封。 */
export const WireFilePageSchema = z.object({
  items: z.array(WireFileSchema),
  next_cursor: NullableString,
});

/** `GET /v1/files/{id}` 直接返回单个文件行。 */
export const WireFileResponseSchema = WireFileSchema;

/** `GET /v1/files/{id}/versions`。 */
export const WireVersionPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      file_id: z.string(),
      version_seq: z.number(),
      size: z.number().nullish(),
      content_type: NullableString,
      committed_at: NullableString,
      conversion_status: NullableString,
    }),
  ),
});

/** `GET /v1/files/{id}/markdown`：转换产物的 markdown，按游标分页（约 64KiB/页）。 */
export const WireMarkdownSchema = z.object({
  file_id: z.string(),
  version_id: z.string(),
  markdown: z.string(),
  next_cursor: NullableString,
  completeness: z.record(z.string(), z.unknown()).nullish(),
});

/** `GET /v1/preview/{id}`：栅格页清单；`url` 含页号与 `version_id`，Fenix 不直接下发。 */
export const WirePreviewSchema = z.object({
  version_id: z.string(),
  pages: z.array(z.object({ page: z.number(), url: z.string() })),
  completeness: z.record(z.string(), z.unknown()).nullish(),
});

/** `POST /v1/files/{id}/conversions`：重新转换任务。 */
export const WireConversionJobSchema = z.object({
  id: z.string(),
  state: z.string(),
  source_version_id: z.string(),
});

/** `GET /v1/trash`。 */
export const WireTrashPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      root_file_id: z.string(),
      original_parent_id: NullableString,
      original_name: z.string(),
      original_path: z.string(),
      deleted_at: NullableString,
      restored_at: NullableString,
      state: z.string(),
      file: WireFileSchema,
    }),
  ),
});

/** `POST /v1/search`。 */
export const WireSearchPageSchema = z.object({
  items: z.array(
    z.object({
      file_id: z.string(),
      path: z.string(),
      returned_version_id: NullableString,
      current_version_id: NullableString,
      stale: z.boolean(),
      newer_version_status: NullableString,
      snippet: z.string(),
      completeness: z.object({
        status: NullableString,
        missing_text_pages: z.array(z.number()).nullish(),
      }),
      location: z.object({
        page: z.number().nullish(),
        block: NullableString,
      }),
    }),
  ),
  next_cursor: NullableString,
});

/** `GET /v1/me`。 */
export const WireMeSchema = z.object({
  id: z.string(),
  display_name: NullableString,
  scopes: z.array(z.string()).nullish(),
  quota: z.object({
    limit_bytes: z.number(),
    used_bytes: z.number(),
    reserved_bytes: z.number(),
    updated_at: NullableString,
  }),
});

/** 变更类动作（mkdir/move/delete/restore）的统一结果。 */
export const WireMutationSchema = z.object({
  operation_id: z.string(),
  file_id: z.string(),
  state: z.enum(["prepared", "executing", "outcome_unknown", "remote_confirmed", "committed", "failed_confirmed"]),
  error_code: NullableString,
  compensated: z.boolean().nullish(),
  message: NullableString,
  file: WireFileSchema.nullish(),
});

/** `POST /v1/uploads`。`upload_url` 刻意不解析：前端不得直连 CloudDrive。 */
export const WireUploadSchema = z.object({
  id: z.string(),
  file_id: z.string(),
  operation_id: z.string(),
  status: z.string(),
  expires_at: NullableString,
});

/** `POST /v1/uploads/{id}/finalize`。 */
export const WireUploadResultSchema = z.object({
  file_id: z.string(),
  version_id: z.string(),
  status: z.string(),
});

/** `POST /v1/uploads/{id}/abandon`。 */
export const WireAbandonResultSchema = z.object({
  upload_id: z.string(),
  file_id: z.string(),
  status: z.string(),
});

export type WireFile = z.infer<typeof WireFileSchema>;
export type WireFilePage = z.infer<typeof WireFilePageSchema>;
export type WireVersionPage = z.infer<typeof WireVersionPageSchema>;
export type WireTrashPage = z.infer<typeof WireTrashPageSchema>;
export type WireSearchPage = z.infer<typeof WireSearchPageSchema>;
export type WireMe = z.infer<typeof WireMeSchema>;
export type WireMutation = z.infer<typeof WireMutationSchema>;
export type WireUpload = z.infer<typeof WireUploadSchema>;
export type WireUploadResult = z.infer<typeof WireUploadResultSchema>;
export type WireAbandonResult = z.infer<typeof WireAbandonResultSchema>;
export type WireMarkdown = z.infer<typeof WireMarkdownSchema>;
export type WirePreview = z.infer<typeof WirePreviewSchema>;
export type WireConversionJob = z.infer<typeof WireConversionJobSchema>;
