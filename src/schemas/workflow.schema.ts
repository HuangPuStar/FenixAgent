import * as z from "zod/v4";

const JsonObjectSchema = z.record(z.string(), z.unknown()).describe("任意 JSON 对象。");
const JsonArraySchema = z.array(z.unknown()).describe("任意 JSON 数组。");
const IsoDateTimeSchema = z.string().describe("时间值，通常为 ISO 8601 字符串。");

/** 通用成功响应工厂 */
const WorkflowSuccessSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    success: z.literal(true).describe("请求是否成功。"),
    data,
  });

/** 通用成功响应（无 data） */
export const WorkflowVoidSuccessSchema = z
  .object({
    success: z.literal(true).describe("请求是否成功。"),
  })
  .describe("工作流接口通用成功响应。");

/** 工作流定义基础信息 */
export const WorkflowDefSchema = z
  .object({
    id: z.string().describe("工作流 ID。"),
    userId: z.string().describe("创建者用户 ID。"),
    organizationId: z.string().describe("所属组织 ID。"),
    name: z.string().describe("工作流名称。"),
    description: z.string().nullable().describe("工作流描述；未填写时为 null。"),
    latestVersion: z.number().nullable().describe("当前指向的最新发布版本号；未发布时可能为 null。"),
    storagePath: z.string().nullable().describe("工作流 YAML 存储目录路径；未初始化时可能为 null。"),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .describe("工作流定义信息。");

/** 工作流定义详情 */
export const WorkflowDefDetailSchema = WorkflowDefSchema.extend({
  draftYaml: z.string().nullable().optional().describe("当前草稿 YAML 内容；不存在时为 null。"),
}).describe("工作流定义详情。");

/** 工作流版本信息 */
export const WorkflowVersionSchema = z
  .object({
    id: z.string().describe("版本记录 ID。"),
    workflowId: z.string().describe("所属工作流 ID。"),
    version: z.number().describe("版本号。"),
    filePath: z.string().describe("对应 YAML 文件路径。"),
    status: z.string().describe("版本状态，例如 published、draft。"),
    createdBy: z.string().describe("发布该版本的用户 ID。"),
    createdAt: IsoDateTimeSchema,
  })
  .describe("工作流版本信息。");

/** 工作流版本 YAML 响应数据 */
export const WorkflowVersionContentSchema = z
  .object({
    workflowId: z.string().describe("所属工作流 ID。"),
    version: z.number().describe("版本号。"),
    yaml: z.string().describe("该版本的 YAML 内容。"),
  })
  .describe("工作流版本 YAML 内容。");

/** 工作流触发器信息 */
export const WorkflowTriggerSchema = z
  .object({
    id: z.string().describe("触发器 ID。"),
    workflowId: z.string().describe("所属工作流 ID。"),
    type: z.string().describe("触发器类型，例如 webhook。"),
    publicHash: z.string().describe("触发器公开标识；列表接口通常返回脱敏值。"),
    maskedHash: z.string().describe("脱敏后的触发器标识。"),
    webhookUrl: z.string().nullable().describe("完整 webhook 地址；仅部分操作会返回。"),
    secret: z.string().nullable().describe("触发器密钥；未配置时为 null。"),
    config: JsonObjectSchema.nullable().describe("触发器配置对象；未配置时为 null。"),
    enabled: z.boolean().describe("触发器是否启用。"),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .describe("工作流触发器信息。");

/** 工作流参数定义响应数据 */
export const WorkflowParamDefsSchema = z
  .object({
    version: z.number().describe("本次解析所使用的工作流版本号。"),
    params: JsonObjectSchema.describe("从工作流 YAML 中提取出的参数定义。"),
  })
  .describe("工作流参数定义。");

/** workflow-defs 请求体 */
export const WorkflowDefsActionRequestSchema = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("create").describe("创建工作流定义。"),
      name: z.string().describe("工作流名称。"),
      description: z.string().optional().describe("工作流描述。"),
    }),
    z.object({
      action: z.literal("save").describe("保存工作流草稿。"),
      workflowId: z.string().describe("工作流 ID。"),
      yaml: z.string().describe("待保存的 YAML 内容。"),
    }),
    z.object({
      action: z.literal("publish").describe("发布草稿为新版本。"),
      workflowId: z.string().describe("工作流 ID。"),
    }),
    z.object({
      action: z.literal("list").describe("获取工作流列表。"),
    }),
    z.object({
      action: z.literal("get").describe("获取工作流详情。"),
      workflowId: z.string().describe("工作流 ID。"),
    }),
    z.object({
      action: z.literal("getVersions").describe("获取工作流版本列表。"),
      workflowId: z.string().describe("工作流 ID。"),
    }),
    z.object({
      action: z.literal("getVersion").describe("获取指定版本 YAML。"),
      workflowId: z.string().describe("工作流 ID。"),
      version: z.number().describe("版本号。"),
    }),
    z.object({
      action: z.literal("setLatest").describe("切换最新版本指针。"),
      workflowId: z.string().describe("工作流 ID。"),
      version: z.number().describe("要设为最新的版本号。"),
    }),
    z.object({
      action: z.literal("delete").describe("删除工作流定义。"),
      workflowId: z.string().describe("工作流 ID。"),
    }),
    z.object({
      action: z.literal("updateMeta").describe("更新工作流元数据。"),
      workflowId: z.string().describe("工作流 ID。"),
      name: z.string().optional().describe("新的工作流名称。"),
      description: z.string().optional().describe("新的工作流描述。"),
    }),
    z.object({
      action: z.literal("recover").describe("扫描可恢复的工作流目录。"),
    }),
    z.object({
      action: z.literal("recoverApply").describe("从文件系统恢复工作流。"),
      workflowIds: z.array(z.string()).min(1).describe("待恢复的工作流 ID 列表。"),
    }),
    z.object({
      action: z.literal("restoreToDraft").describe("将某个版本恢复为草稿。"),
      workflowId: z.string().describe("工作流 ID。"),
      version: z.number().describe("要恢复到草稿区的版本号。"),
    }),
    z.object({
      action: z.literal("createTrigger").describe("创建工作流触发器。"),
      workflowId: z.string().describe("工作流 ID。"),
      type: z.string().optional().describe("触发器类型；默认 webhook。"),
      config: JsonObjectSchema.optional().describe("触发器配置。"),
    }),
    z.object({
      action: z.literal("listTriggers").describe("列出工作流触发器。"),
      workflowId: z.string().describe("工作流 ID。"),
    }),
    z.object({
      action: z.literal("deleteTrigger").describe("删除工作流触发器。"),
      triggerId: z.string().describe("触发器 ID。"),
    }),
    z.object({
      action: z.literal("regenerateHash").describe("重新生成触发器公开哈希。"),
      triggerId: z.string().describe("触发器 ID。"),
    }),
    z.object({
      action: z.literal("enableTrigger").describe("启用工作流触发器。"),
      triggerId: z.string().describe("触发器 ID。"),
    }),
    z.object({
      action: z.literal("disableTrigger").describe("禁用工作流触发器。"),
      triggerId: z.string().describe("触发器 ID。"),
    }),
    z.object({
      action: z.literal("getParamDefs").describe("提取工作流参数定义。"),
      workflowId: z.string().describe("工作流 ID。"),
      version: z.number().optional().describe("可选版本号；未传时使用最新版本。"),
    }),
  ])
  .describe("工作流定义接口的 action 分发请求体。");

/** workflow-defs 响应 */
export const WorkflowDefsActionResponseSchema = z
  .union([
    WorkflowSuccessSchema(WorkflowDefSchema),
    WorkflowSuccessSchema(WorkflowDefDetailSchema),
    WorkflowSuccessSchema(WorkflowDefSchema.array()),
    WorkflowSuccessSchema(WorkflowVersionSchema),
    WorkflowSuccessSchema(WorkflowVersionSchema.array()),
    WorkflowSuccessSchema(WorkflowVersionContentSchema),
    WorkflowSuccessSchema(z.array(z.string()).describe("可恢复的工作流 ID 列表。")),
    WorkflowSuccessSchema(WorkflowTriggerSchema),
    WorkflowSuccessSchema(WorkflowTriggerSchema.array()),
    WorkflowSuccessSchema(WorkflowParamDefsSchema),
    WorkflowVoidSuccessSchema,
  ])
  .describe("工作流定义接口的可能成功响应。");

/** DAG 运行状态枚举 */
export const WorkflowDagStatusSchema = z
  .enum(["PENDING", "RUNNING", "SUSPENDED", "FAILED", "CANCELLED", "ERROR", "SUCCESS"])
  .describe("工作流 DAG 运行状态。");

/** 节点状态枚举 */
export const WorkflowNodeStatusSchema = z
  .enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "SKIPPED"])
  .describe("工作流节点执行状态。");

/** 节点输出 */
export const WorkflowNodeOutputSchema = z
  .object({
    stdout: z.string().describe("节点标准输出文本。"),
    json: z.unknown().optional().describe("节点结构化输出。"),
    exit_code: z.number().describe("节点退出码。"),
    size: z.number().optional().describe("输出大小，单位字节。"),
    ref: z.string().optional().describe("外部输出引用。"),
  })
  .describe("工作流节点输出。");

/** DAG 事件 */
export const WorkflowDagEventSchema = z
  .object({
    event_id: z.string().describe("事件 ID。"),
    run_id: z.string().describe("运行 ID。"),
    project_id: z.string().optional().describe("项目或工作流关联 ID。"),
    node_id: z.string().optional().describe("关联节点 ID。"),
    timestamp: z.string().describe("事件时间。"),
    type: z.string().describe("事件类型。"),
    node_type: z.string().optional().describe("节点类型。"),
    metadata: JsonObjectSchema.optional().describe("附加事件元数据。"),
  })
  .describe("工作流 DAG 事件。");

/** DAG 快照 */
export const WorkflowDagSnapshotSchema = z
  .object({
    snapshot_id: z.string().describe("快照 ID。"),
    run_id: z.string().describe("运行 ID。"),
    last_event_id: z.string().describe("最新已消费事件 ID。"),
    timestamp: z.string().describe("快照生成时间。"),
    node_states: z
      .record(
        z.string(),
        z.object({
          status: WorkflowNodeStatusSchema.describe("节点状态。"),
          exit_code: z.number().optional().describe("节点退出码。"),
        }),
      )
      .describe("按节点 ID 索引的节点状态表。"),
    dag_status: WorkflowDagStatusSchema.describe("当前 DAG 整体状态。"),
  })
  .describe("工作流运行状态快照。");

/** 运行摘要 */
export const WorkflowRunSummarySchema = z
  .object({
    run_id: z.string().describe("运行 ID。"),
    project_id: z.string().optional().describe("项目或工作流关联 ID。"),
    workflow_id: z.string().optional().describe("工作流 ID。"),
    workflow_name: z.string().describe("工作流名称。"),
    status: WorkflowDagStatusSchema.describe("运行状态。"),
    started_at: z.string().describe("开始时间。"),
    completed_at: z.string().optional().describe("完成时间。"),
    node_summary: z
      .object({
        total: z.number().describe("节点总数。"),
        completed: z.number().describe("已完成节点数。"),
        failed: z.number().describe("失败节点数。"),
        running: z.number().describe("运行中节点数。"),
      })
      .describe("节点执行统计。"),
  })
  .describe("工作流运行摘要。");

/** DAG 最终运行结果 */
export const WorkflowDagRunResultSchema = z
  .object({
    runId: z.string().describe("运行 ID。"),
    status: WorkflowDagStatusSchema.describe("最终运行状态。"),
    summary: WorkflowRunSummarySchema.describe("运行摘要。"),
    spawnedEnvIds: z.array(z.string()).optional().describe("本次运行期间拉起的环境 ID 列表。"),
  })
  .describe("工作流运行结果。");

/** dryRun 执行计划 */
export const WorkflowDryRunResultSchema = z
  .object({
    valid: z.boolean().describe("YAML 是否通过基础校验。"),
    issues: JsonArraySchema.describe("校验问题列表。"),
    executionPlan: z
      .object({
        topologicalOrder: z.array(z.string()).describe("拓扑排序后的节点执行顺序。"),
        parallelGroups: z.array(z.array(z.string())).describe("可并行执行的节点分组。"),
      })
      .describe("干运行生成的执行计划。"),
  })
  .describe("工作流干运行结果。");

/** 待审批节点 */
export const WorkflowPendingApprovalSchema = z
  .object({
    runId: z.string().describe("运行 ID。"),
    nodeId: z.string().describe("待审批节点 ID。"),
    approvalToken: z.string().describe("审批令牌。"),
    expiresAt: z.string().describe("令牌过期时间。"),
    displayData: z.unknown().optional().describe("审批展示数据。"),
  })
  .describe("工作流待审批节点信息。");

/** 运行启动响应数据 */
export const WorkflowRunStartedSchema = z
  .object({
    runId: z.string().describe("新启动的运行 ID。"),
    status: z.literal("RUNNING").describe("启动后的初始运行状态。"),
  })
  .describe("启动工作流后的返回数据。");

/** workflow-engine 请求体 */
export const WorkflowEngineActionRequestSchema = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("run").describe("执行工作流。"),
      yaml: z.string().describe("待执行的工作流 YAML。"),
      params: JsonObjectSchema.optional().describe("运行参数。"),
      workflowId: z.string().optional().describe("可选工作流 ID，用于事件归档。"),
    }),
    z.object({
      action: z.literal("dryRun").describe("对工作流进行干运行校验。"),
      yaml: z.string().describe("待校验的工作流 YAML。"),
      workflowId: z.string().optional().describe("可选工作流 ID，用于发布干运行事件。"),
    }),
    z.object({
      action: z.literal("cancel").describe("取消运行。"),
      runId: z.string().describe("运行 ID。"),
      workflowId: z.string().optional().describe("可选工作流 ID，用于发布事件。"),
    }),
    z.object({
      action: z.literal("approve").describe("审批通过挂起节点。"),
      runId: z.string().describe("运行 ID。"),
      nodeId: z.string().describe("节点 ID。"),
      token: z.string().describe("审批 token。"),
      data: z.unknown().optional().describe("审批附加数据。"),
      workflowId: z.string().optional().describe("可选工作流 ID，用于发布事件。"),
    }),
    z.object({
      action: z.literal("getRunStatus").describe("获取运行状态快照。"),
      runId: z.string().describe("运行 ID。"),
    }),
    z.object({
      action: z.literal("getEvents").describe("获取运行事件列表。"),
      runId: z.string().describe("运行 ID。"),
      nodeId: z.string().optional().describe("可选节点 ID；传入后仅筛选该节点事件。"),
    }),
    z.object({
      action: z.literal("getOutput").describe("获取单个节点输出。"),
      runId: z.string().describe("运行 ID。"),
      nodeId: z.string().describe("节点 ID。"),
    }),
    z.object({
      action: z.literal("getPendingApprovals").describe("获取待审批节点列表。"),
      runId: z.string().describe("运行 ID。"),
    }),
    z.object({
      action: z.literal("listRuns").describe("列出运行记录。"),
    }),
    z.object({
      action: z.literal("recover").describe("从快照恢复运行。"),
      runId: z.string().describe("运行 ID。"),
      yaml: z.string().describe("恢复时使用的工作流 YAML。"),
    }),
    z.object({
      action: z.literal("rerunFrom").describe("从指定节点重新运行。"),
      runId: z.string().describe("上一轮运行 ID。"),
      fromNodeId: z.string().describe("重新运行的起始节点 ID。"),
      yaml: z.string().describe("执行使用的工作流 YAML。"),
      workflowId: z.string().optional().describe("可选工作流 ID，用于归档与事件发布。"),
    }),
  ])
  .describe("工作流引擎接口的 action 分发请求体。");

/** workflow-engine 响应 */
export const WorkflowEngineActionResponseSchema = z
  .union([
    WorkflowSuccessSchema(WorkflowRunStartedSchema),
    WorkflowSuccessSchema(WorkflowDryRunResultSchema),
    WorkflowSuccessSchema(WorkflowDagSnapshotSchema.nullable().describe("运行状态快照；不存在时为 null。")),
    WorkflowSuccessSchema(WorkflowDagEventSchema.array().describe("运行事件列表。")),
    WorkflowSuccessSchema(WorkflowNodeOutputSchema.nullable().describe("节点输出；尚未产生时为 null。")),
    WorkflowSuccessSchema(WorkflowPendingApprovalSchema.array().describe("待审批节点列表。")),
    WorkflowSuccessSchema(WorkflowRunSummarySchema.array().describe("运行摘要列表。")),
    WorkflowSuccessSchema(WorkflowDagRunResultSchema),
    WorkflowVoidSuccessSchema,
  ])
  .describe("工作流引擎接口的可能成功响应。");

/** 看板 Job 基础信息 */
export const WorkflowJobSchema = z
  .object({
    id: z.string().describe("Job ID。"),
    boardId: z.string().describe("所属看板 ID。"),
    organizationId: z.string().describe("所属组织 ID。"),
    userId: z.string().describe("创建者用户 ID。"),
    workflowId: z.string().describe("绑定的工作流 ID。"),
    version: z.number().describe("绑定的工作流版本号。"),
    params: JsonObjectSchema.nullable().describe("Job 运行参数；未设置时为 null。"),
    status: z.string().describe("Job 当前状态，例如 ready、running、suspended、completed。"),
    lastRunId: z.string().nullable().describe("最近一次运行 ID；未执行时为 null。"),
    lastDagStatus: z.string().nullable().describe("最近一次 DAG 运行状态；未执行时为 null。"),
    runCount: z.number().describe("已运行次数。"),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .describe("工作流看板 Job 信息。");

/** Job 列表项 */
export const WorkflowJobListItemSchema = WorkflowJobSchema.extend({
  workflowName: z.string().describe("工作流名称。"),
  userName: z.string().nullable().describe("创建者用户名；不可用时为 null。"),
}).describe("工作流看板 Job 列表项。");

/** Job 运行返回数据 */
export const WorkflowJobRunResultSchema = z
  .object({
    runId: z.string().describe("触发后的运行 ID。"),
  })
  .describe("触发 Job 运行后的返回数据。");

/** Job 节点输出项 */
export const WorkflowJobOutputItemSchema = z
  .object({
    nodeId: z.string().describe("节点 ID。"),
    nodeType: z.string().nullable().describe("节点类型；未知时为 null。"),
    stdout: z.string().describe("节点标准输出。"),
    json: z.unknown().nullable().describe("节点结构化输出；没有时为 null。"),
    exitCode: z.number().describe("节点退出码。"),
    status: z.string().describe("节点输出对应的执行状态。"),
    startedAt: z.string().nullable().describe("节点开始时间；未知时为 null。"),
    completedAt: z.string().nullable().describe("节点完成时间；未知时为 null。"),
  })
  .describe("Job 节点输出摘要。");

/** workflow-jobs 请求体 */
export const WorkflowJobsActionRequestSchema = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("create").describe("创建 Job。"),
      workflowId: z.string().describe("工作流 ID。"),
      boardId: z.string().describe("看板 ID。"),
      params: JsonObjectSchema.optional().describe("Job 初始运行参数。"),
    }),
    z.object({
      action: z.literal("list").describe("获取 Job 列表。"),
      boardId: z.string().optional().describe("可选看板 ID；传入后仅查询该看板。"),
    }),
    z.object({
      action: z.literal("get").describe("获取单个 Job。"),
      jobId: z.string().describe("Job ID。"),
    }),
    z.object({
      action: z.literal("updateParams").describe("更新 Job 参数。"),
      jobId: z.string().describe("Job ID。"),
      params: JsonObjectSchema.describe("新的参数对象。"),
    }),
    z.object({
      action: z.literal("delete").describe("删除 Job。"),
      jobId: z.string().describe("Job ID。"),
    }),
    z.object({
      action: z.literal("run").describe("运行 Job。"),
      jobId: z.string().describe("Job ID。"),
    }),
    z.object({
      action: z.literal("cancel").describe("取消 Job 当前运行。"),
      jobId: z.string().describe("Job ID。"),
    }),
    z.object({
      action: z.literal("getPendingApprovals").describe("获取 Job 当前运行的待审批节点。"),
      jobId: z.string().describe("Job ID。"),
    }),
    z.object({
      action: z.literal("approve").describe("审批通过 Job 的挂起节点。"),
      jobId: z.string().describe("Job ID。"),
      nodeId: z.string().describe("节点 ID。"),
      token: z.string().describe("审批 token。"),
      data: z.unknown().optional().describe("审批附加数据。"),
    }),
    z.object({
      action: z.literal("getOutputs").describe("获取 Job 当前运行的节点输出列表。"),
      jobId: z.string().describe("Job ID。"),
    }),
  ])
  .describe("工作流 Job 接口的 action 分发请求体。");

/** workflow-jobs 响应 */
export const WorkflowJobsActionResponseSchema = z
  .union([
    WorkflowSuccessSchema(WorkflowJobSchema),
    WorkflowSuccessSchema(WorkflowJobListItemSchema.array()),
    WorkflowSuccessSchema(WorkflowJobRunResultSchema),
    WorkflowSuccessSchema(WorkflowPendingApprovalSchema.array()),
    WorkflowSuccessSchema(WorkflowJobOutputItemSchema.array()),
    WorkflowVoidSuccessSchema,
  ])
  .describe("工作流 Job 接口的可能成功响应。");

/** 工作流统计概览 */
export const WorkflowStatsOverviewSchema = z
  .object({
    totalRuns: z.number().describe("统计范围内的总运行数。"),
    successRuns: z.number().describe("成功运行数。"),
    failedRuns: z.number().describe("失败、错误或取消的运行数。"),
    successRate: z.number().describe("成功率，百分比。"),
    avgDurationMs: z.number().describe("平均运行耗时，单位毫秒。"),
    totalInputTokens: z.number().describe("输入 Token 总量。"),
    totalOutputTokens: z.number().describe("输出 Token 总量。"),
  })
  .describe("工作流统计概览。");

/** 按天统计的运行趋势 */
export const WorkflowStatsDailyCountSchema = z
  .object({
    date: z.string().describe("日期，格式通常为 YYYY-MM-DD。"),
    success: z.number().describe("当日成功运行数。"),
    failed: z.number().describe("当日失败运行数。"),
  })
  .describe("按天统计的工作流运行趋势项。");

/** 按天统计的 Token 消耗 */
export const WorkflowStatsTokenDailySchema = z
  .object({
    date: z.string().describe("日期，格式通常为 YYYY-MM-DD。"),
    inputTokens: z.number().describe("当日输入 Token 数。"),
    outputTokens: z.number().describe("当日输出 Token 数。"),
  })
  .describe("按天统计的 Token 消耗项。");

/** 最近失败运行 */
export const WorkflowFailedRunSchema = z
  .object({
    runId: z.string().describe("运行 ID。"),
    workflowId: z.string().describe("工作流 ID。"),
    workflowName: z.string().describe("工作流名称。"),
    dagStatus: z.string().describe("终态状态。"),
    startedAt: z.string().describe("开始时间。"),
    completedAt: z.string().nullable().describe("结束时间；仍不可用时为 null。"),
    durationMs: z.number().nullable().describe("运行耗时，单位毫秒；不可计算时为 null。"),
  })
  .describe("最近失败的工作流运行记录。");

/** workflow-stats 请求体 */
export const WorkflowStatsActionRequestSchema = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("overview").describe("获取统计概览。"),
      range: z.string().optional().describe("统计范围；常用值为 7d、30d，其他值按默认策略处理。"),
    }),
    z.object({
      action: z.literal("trend").describe("获取按天运行趋势。"),
      range: z.string().optional().describe("统计范围；常用值为 7d、30d，其他值按默认策略处理。"),
    }),
    z.object({
      action: z.literal("tokens").describe("获取按天 Token 消耗。"),
      range: z.string().optional().describe("统计范围；常用值为 7d、30d，其他值按默认策略处理。"),
    }),
    z.object({
      action: z.literal("failedRuns").describe("获取最近失败运行列表。"),
      range: z.string().optional().describe("保留字段；当前主要按默认逻辑返回。"),
    }),
  ])
  .describe("工作流统计接口的 action 分发请求体。");

/** workflow-stats 响应 */
export const WorkflowStatsActionResponseSchema = z
  .union([
    WorkflowSuccessSchema(WorkflowStatsOverviewSchema),
    WorkflowSuccessSchema(WorkflowStatsDailyCountSchema.array()),
    WorkflowSuccessSchema(WorkflowStatsTokenDailySchema.array()),
    WorkflowSuccessSchema(WorkflowFailedRunSchema.array()),
  ])
  .describe("工作流统计接口的可能成功响应。");

/** SSE fromSeqNum 查询参数 */
export const WorkflowEventStreamQuerySchema = z
  .object({
    fromSeqNum: z.coerce.number().int().nonnegative().optional().describe("从指定事件序号开始回放历史事件。"),
  })
  .describe("工作流 SSE 事件流查询参数。");

/** workflow/:workflowId/events 路径参数 */
export const WorkflowEventStreamParamsSchema = z
  .object({
    workflowId: z.string().describe("工作流 ID。"),
  })
  .describe("工作流 SSE 事件流路径参数。");

/** workflow-jobs/:jobId/logs 路径参数 */
export const WorkflowJobLogsParamsSchema = z
  .object({
    jobId: z.string().describe("Job ID。"),
  })
  .describe("工作流 Job 日志流路径参数。");

/** 工作流 SSE 事件负载 */
export const WorkflowStreamEventPayloadSchema = z
  .object({
    type: z.string().describe("事件类型。"),
    workflowId: z.string().optional().describe("关联工作流 ID。"),
  })
  .catchall(z.unknown())
  .describe("工作流 SSE 事件负载。");

/** 看板 SSE 事件负载 */
export const WorkflowJobStreamEventPayloadSchema = z
  .object({
    type: z.string().describe("事件类型。"),
    jobId: z.string().describe("关联 Job ID。"),
  })
  .catchall(z.unknown())
  .describe("看板 Job SSE 事件负载。");
