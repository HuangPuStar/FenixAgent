import * as z from "zod/v4";

// 文件事件订阅端点（WS /web/file-events）的帧契约，docs/arch/12-files.md §4.3。
// 本文件是帧 schema 的唯一真相来源：W4b（端点）用订阅帧做入站校验，
// 波次 4 的 W7（限频/合并器）复用事件帧语义，新增帧类型必须同步扩展此处。

/** 文件变更类型（事件帧契约） */
export const FileChangeKindSchema = z.enum(["write", "delete", "mkdir", "rename", "upload"]);
export type FileChangeKind = z.infer<typeof FileChangeKindSchema>;

/** 变更来源（契约先行审计字段，本期只定义不落库） */
export const FileChangeSourceSchema = z.enum(["user", "agent", "api"]);
export type FileChangeSource = z.infer<typeof FileChangeSourceSchema>;

/** 订阅帧：声明要订阅的环境列表，服务端逐环境校验访问权 */
export const FileEventsSubscribeSchema = z.object({
  type: z.literal("subscribe"),
  environments: z.array(z.string().min(1)),
});
export type FileEventsSubscribe = z.infer<typeof FileEventsSubscribeSchema>;

/** 订阅失败帧：区分"无权限"与"网络故障"（无权限必须显式回帧，不得静默忽略） */
export const FileEventsSubscribeErrorSchema = z.object({
  type: z.literal("subscribe_error"),
  environment_id: z.string(),
  code: z.literal("forbidden"),
});
export type FileEventsSubscribeError = z.infer<typeof FileEventsSubscribeErrorSchema>;

/** file_changed 事件帧：to 为 rename 目标路径 */
export const FileChangedEventSchema = z.object({
  type: z.literal("file_changed"),
  environment_id: z.string(),
  path: z.string(),
  kind: FileChangeKindSchema,
  source: FileChangeSourceSchema,
  actor_id: z.string().optional(),
  to: z.string().optional(),
});
export type FileChangedEvent = z.infer<typeof FileChangedEventSchema>;

/** file_changed_batch 中的单条变更（增量语义，不是 invalidate_all） */
export const FileBatchChangeSchema = z.object({
  path: z.string(),
  kind: FileChangeKindSchema,
  source: FileChangeSourceSchema,
  actor_id: z.string().optional(),
});
export type FileBatchChange = z.infer<typeof FileBatchChangeSchema>;

/** 批量变更帧：突发合并用增量语义（≤50 条路径列表） */
export const FileChangedBatchEventSchema = z.object({
  type: z.literal("file_changed_batch"),
  environment_id: z.string(),
  changes: z.array(FileBatchChangeSchema),
});
export type FileChangedBatchEvent = z.infer<typeof FileChangedBatchEventSchema>;

/** 全量失效帧：仅用于未知范围（机器重连、path 未知的外部变更） */
export const FileInvalidateAllEventSchema = z.object({
  type: z.literal("invalidate_all"),
  environment_id: z.string(),
});
export type FileInvalidateAllEvent = z.infer<typeof FileInvalidateAllEventSchema>;

/** 降级帧：机器文件能力 down/recovered，限频合并（1 条/30s/machine） */
export const FileDegradedEventSchema = z.object({
  type: z.literal("degraded"),
  machine_id: z.string(),
  capability: z.literal("file"),
  status: z.enum(["down", "recovered"]),
});
export type FileDegradedEvent = z.infer<typeof FileDegradedEventSchema>;

/** 出站事件帧联合（按 type 判别；订阅侧接收的全部帧类型） */
export const FileEventFrameSchema = z.discriminatedUnion("type", [
  FileChangedEventSchema,
  FileChangedBatchEventSchema,
  FileInvalidateAllEventSchema,
  FileDegradedEventSchema,
]);
export type FileEventFrame = z.infer<typeof FileEventFrameSchema>;
