import * as z from "zod/v4";
import { OkResponseSchema } from "./common.schema";

/** 环境基础信息 */
export const EnvironmentInfoSchema = z
  .object({
    id: z.string().describe("环境 ID。"),
    name: z.string().describe("环境名称。"),
    description: z.string().nullable().describe("环境描述；未填写时为 null。"),
    workspace_path: z.string().describe("环境工作目录路径。"),
    agent_config_id: z.string().nullable().describe("绑定的 Agent 配置 ID；未绑定时为 null。"),
    status: z.string().describe("当前环境状态，例如 active、idle、offline、error。"),
    machine_name: z.string().nullable().describe("绑定的远端机器名称；本地环境时为 null。"),
    branch: z.string().nullable().describe("当前工作区分支名；不可用时为 null。"),
    auto_start: z.boolean().describe("服务启动后是否自动拉起实例。"),
    last_poll_at: z.number().nullable().describe("最近一次心跳轮询时间，单位为秒级时间戳。"),
    created_at: z.number().describe("环境创建时间，单位为秒级时间戳。"),
    updated_at: z.number().describe("环境更新时间，单位为秒级时间戳。"),
  })
  .describe("环境基础信息。");

/** 环境下的实例摘要 */
export const InstanceSummarySchema = z
  .object({
    id: z.string().describe("实例 ID。"),
    instance_number: z.number().describe("环境内的实例序号。"),
    status: z.string().describe("当前实例状态。"),
    session_id: z.string().nullable().describe("当前绑定的会话 ID；未绑定时为 null。"),
    port: z.number().describe("实例暴露的本地端口。"),
    created_at: z.number().describe("实例创建时间，单位为秒级时间戳。"),
  })
  .describe("环境实例摘要。");

/** 环境列表项 */
export const EnvironmentListResponseSchema = EnvironmentInfoSchema.extend({
  agent_name: z.string().nullable().describe("绑定的 Agent 配置名称；未绑定时为 null。"),
  session_id: z.string().nullable().describe("当前活跃实例绑定的会话 ID；不存在时为 null。"),
  instance_status: z.string().nullable().describe("当前活跃实例状态；不存在时为 null。"),
  instance_id: z.string().nullable().describe("当前活跃实例 ID；不存在时为 null。"),
  instances: InstanceSummarySchema.array().describe("当前环境下的活跃实例列表。"),
  instances_count: z.number().describe("当前环境下的活跃实例数量。"),
}).describe("环境列表项。");

/** 环境列表响应 */
export const EnvironmentListSchema = EnvironmentListResponseSchema.array().describe("环境列表响应。");

/** 环境列表查询参数 */
export const EnvironmentListQuerySchema = z
  .object({
    mine: z.boolean().optional().describe("仅返回当前用户创建的环境；未传或为 false 时返回当前组织下所有环境。"),
  })
  .describe("环境列表查询参数。");

/** 环境详情响应 */
export const EnvironmentDetailResponseSchema = EnvironmentInfoSchema.extend({
  secret: z.string().describe("环境密钥，用于环境级鉴权。"),
}).describe("环境详情响应。");

/** 创建环境请求 */
export const CreateEnvironmentRequestSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "name 必须为 kebab-case 格式")
      .describe("环境名称，必须为 kebab-case。"),
    agentConfigId: z.string().min(1).optional().describe("可选的 Agent 配置 ID。"),
    description: z.string().optional().describe("可选的环境描述。"),
    autoStart: z.boolean().optional().describe("是否在服务启动后自动拉起实例。"),
  })
  .describe("创建环境请求。");

/** 更新环境请求 */
export const UpdateEnvironmentRequestSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "name 必须为 kebab-case 格式")
      .optional()
      .describe("新的环境名称，必须为 kebab-case。"),
    agentConfigId: z.string().nullable().optional().describe("新的 Agent 配置 ID；传 null 表示解绑。"),
    description: z.string().nullable().optional().describe("新的环境描述；传 null 表示清空。"),
    autoStart: z.boolean().optional().describe("新的自动启动开关。"),
  })
  .describe("更新环境请求。");

/** 进入环境请求 */
export const EnterEnvironmentRequestSchema = z
  .object({
    instance_number: z.number().int().positive().optional().describe("可选的实例序号；传入后直接进入指定实例。"),
  })
  .describe("进入环境请求。");

/** 进入环境响应 */
export const EnterEnvironmentResponseSchema = z
  .object({
    session_id: z.string().nullable().describe("创建或复用的会话 ID；当前未创建时为 null。"),
    instance_id: z.string().describe("进入的实例 ID。"),
    instance_number: z.number().describe("进入的实例序号。"),
    instance_status: z.string().describe("进入后的实例状态。"),
    environment_id: z.string().describe("所属环境 ID。"),
  })
  .describe("进入环境响应。");

/** 环境实例列表响应 */
export const ListInstancesResponseSchema = z
  .object({
    environment_id: z.string().describe("所属环境 ID。"),
    instances: InstanceSummarySchema.array().describe("当前环境下的活跃实例列表。"),
  })
  .describe("环境实例列表响应。");

/** 创建环境响应 */
export const CreateEnvironmentResponseSchema = EnvironmentDetailResponseSchema;

/** PUT /web/environments/:id — 更新环境后的响应 */
export const UpdateEnvironmentResponseSchema = EnvironmentInfoSchema;

/** DELETE /web/environments/:id — 删除环境响应 */
export const DeleteEnvironmentResponseSchema = OkResponseSchema;

export type EnvironmentInfo = z.infer<typeof EnvironmentInfoSchema>;
export type EnvironmentListResponse = z.infer<typeof EnvironmentListResponseSchema>;
export type EnvironmentListQuery = z.infer<typeof EnvironmentListQuerySchema>;
export type EnvironmentDetailResponse = z.infer<typeof EnvironmentDetailResponseSchema>;
export type CreateEnvironmentRequest = z.infer<typeof CreateEnvironmentRequestSchema>;
export type UpdateEnvironmentRequest = z.infer<typeof UpdateEnvironmentRequestSchema>;
export type EnterEnvironmentRequest = z.infer<typeof EnterEnvironmentRequestSchema>;
export type CreateEnvironmentResponse = z.infer<typeof CreateEnvironmentResponseSchema>;
export type EnterEnvironmentResponse = z.infer<typeof EnterEnvironmentResponseSchema>;
export type ListInstancesResponse = z.infer<typeof ListInstancesResponseSchema>;
export type UpdateEnvironmentResponse = z.infer<typeof UpdateEnvironmentResponseSchema>;
export type DeleteEnvironmentResponse = z.infer<typeof DeleteEnvironmentResponseSchema>;
