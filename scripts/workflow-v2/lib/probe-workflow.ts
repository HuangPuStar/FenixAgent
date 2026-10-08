/**
 * 上游契约探针的主链路套件：画布与草稿、调试运行、发布与复制。
 *
 * 与入口 `../upstream-contract-probe.ts` 及同级探针模块共同工作；模块按「采集基建 / 引导资源 /
 * 主链路套件 / 辅助套件 / 编排」拆分，为的是守住单文件规模。
 */

import { deleteWorkflow } from "./probe-auxiliary";
import { repairDefaultSchema } from "./probe-bootstrap";
import { asString, get, type ProbeRun, pick, post, probe, type RunContext } from "./probe-core";
import { GROUP_RUN, GROUP_VERSION, GROUP_WORKFLOW, PROBE_WORKFLOW_NAME, WORKFLOW_ICON_URI } from "./probe-shared";

/** 画布与草稿：canvas → save（失败样本 + 成功样本）→ update_meta → workflow_list → 版本历史 → 画布校验。 */
export async function probeCanvasAndSave(context: RunContext): Promise<void> {
  const canvasRun = await probe(
    context,
    post("workflow_api.canvas", GROUP_WORKFLOW, "拉画布（含 schema_json）", "/api/workflow_api/canvas", {
      body: { workflow_id: context.workflowId, space_id: context.spaceId },
    }),
  );
  const schemaText = asString(pick(canvasRun.response?.json, ["data", "workflow", "schema_json"]));
  if (!schemaText) return;
  const repaired = repairDefaultSchema(schemaText);

  await probe(
    context,
    post("workflow_api.save.min", GROUP_WORKFLOW, "保存草稿（只传 workflow_id/space_id）", "/api/workflow_api/save", {
      body: { workflow_id: context.workflowId, space_id: context.spaceId },
      expectation: "error-shape",
    }),
  );
  await probe(
    context,
    post("workflow_api.save", GROUP_WORKFLOW, "保存草稿（提交修复后的 schema）", "/api/workflow_api/save", {
      body: {
        workflow_id: context.workflowId,
        space_id: context.spaceId,
        schema: repaired.schema,
        submit_commit_id: "",
      },
      note: repaired.detail,
    }),
  );
  await probe(
    context,
    post("workflow_api.update_meta", GROUP_WORKFLOW, "重命名 / 改描述 / 改图标", "/api/workflow_api/update_meta", {
      body: {
        workflow_id: context.workflowId,
        space_id: context.spaceId,
        name: PROBE_WORKFLOW_NAME,
        desc: "workflow-v2 contract probe",
        icon_uri: WORKFLOW_ICON_URI,
      },
    }),
  );
  await probe(
    context,
    post(
      "workflow_api.workflow_list",
      GROUP_WORKFLOW,
      "列表（必须带 project_id，否则 App 内 workflow 不可见）",
      "/api/workflow_api/workflow_list",
      {
        body: { space_id: context.spaceId, project_id: context.appId, page: 1, size: 10 },
      },
    ),
  );
  await probe(
    context,
    post(
      "workflow_api.workflow_list.by_ids.no_paging",
      GROUP_WORKFLOW,
      "按 workflow_ids 查询但缺 page/size",
      "/api/workflow_api/workflow_list",
      {
        body: { space_id: context.spaceId, workflow_ids: [context.workflowId] },
        expectation: "error-shape",
      },
    ),
  );
  await probe(
    context,
    post(
      "workflow_api.workflow_list.by_ids",
      GROUP_WORKFLOW,
      "按 workflow_ids 查归属（必须同时带 project_id 与 page/size）",
      "/api/workflow_api/workflow_list",
      {
        body: {
          space_id: context.spaceId,
          project_id: context.appId,
          workflow_ids: [context.workflowId],
          page: 1,
          size: 10,
        },
        note: "workflow_ids 查询缺 project_id 时返回空列表，缺 page/size 时报 777777775",
      },
    ),
  );
  await probe(
    context,
    post(
      "workflow_api.history_schema",
      GROUP_WORKFLOW,
      "版本历史（无 commit 的 workflow 上采集失败样本）",
      "/api/workflow_api/history_schema",
      {
        body: { space_id: context.spaceId, workflow_id: context.workflowId, type: 0 },
      },
    ),
  );
  await probe(
    context,
    post(
      "workflow_api.validate_tree",
      GROUP_WORKFLOW,
      "画布校验（schema + bind_project_id/bind_bot_id）",
      "/api/workflow_api/validate_tree",
      {
        body: {
          workflow_id: context.workflowId,
          space_id: context.spaceId,
          schema: repaired.schema,
          bind_project_id: context.appId,
          bind_bot_id: context.appId,
        },
      },
    ),
  );
}

/** 调试运行：node_type → test_run → get_process / 节点历史 → cancel / test_resume。 */
export async function probeRun(context: RunContext): Promise<void> {
  await probe(
    context,
    post(
      "workflow_api.node_type",
      GROUP_RUN,
      "画布可用节点类型（依赖已保存的 schema）",
      "/api/workflow_api/node_type",
      {
        body: { space_id: context.spaceId, workflow_id: context.workflowId },
      },
    ),
  );
  const runResult: ProbeRun = await probe(
    context,
    post("workflow_api.test_run", GROUP_RUN, "调试运行", "/api/workflow_api/test_run", {
      body: { workflow_id: context.workflowId, space_id: context.spaceId, input: {} },
    }),
  );
  context.executeId = asString(pick(runResult.response?.json, ["data", "execute_id"]));

  await probe(
    context,
    get("workflow_api.get_process", GROUP_RUN, "运行过程轮询（GET + query）", "/api/workflow_api/get_process", {
      query: {
        workflow_id: context.workflowId,
        space_id: context.spaceId,
        ...(context.executeId ? { execute_id: context.executeId } : {}),
      },
      expectation: context.executeId ? "success" : "error-shape",
    }),
  );
  await probe(
    context,
    post(
      "workflow_api.get_process.wrong_method",
      GROUP_RUN,
      "get_process 用 POST 调用（路由只挂 GET）",
      "/api/workflow_api/get_process",
      {
        body: { workflow_id: context.workflowId, space_id: context.spaceId },
        expectation: "error-shape",
      },
    ),
  );
  await probe(
    context,
    get(
      "workflow_api.get_node_execute_history",
      GROUP_RUN,
      "节点执行历史（node_id/node_type 必填）",
      "/api/workflow_api/get_node_execute_history",
      {
        query: {
          workflow_id: context.workflowId,
          space_id: context.spaceId,
          node_id: "100001",
          node_type: "1",
          ...(context.executeId ? { execute_id: context.executeId } : {}),
        },
      },
    ),
  );
  await probe(
    context,
    post("workflow_api.cancel", GROUP_RUN, "取消运行（对已结束的 execute_id 幂等返回）", "/api/workflow_api/cancel", {
      body: { execute_id: context.executeId ?? "", space_id: context.spaceId, workflow_id: context.workflowId },
    }),
  );
  await probe(
    context,
    post(
      "workflow_api.test_resume",
      GROUP_RUN,
      "中断恢复（无真实中断事件，采集拒绝样本）",
      "/api/workflow_api/test_resume",
      {
        body: {
          workflow_id: context.workflowId,
          execute_id: context.executeId ?? "",
          event_id: "",
          data: "{}",
          space_id: context.spaceId,
        },
      },
    ),
  );
}

/**
 * 生成单调递增的发布版本号：`v1.0.<epoch 秒>`。
 *
 * 实测：不带 `workflow_version` 时，首次发布成功、再次发布同一 workflow 返回 `720700801
 * database operation failed`（版本重复）；带旧版本号则返回 `777777775 the version number is not
 * self-incrementing`。探针用时间派生的版本号保证每次运行都能取到成功样本，另用同版本的第二次
 * 调用取拒绝样本。同一秒内连跑两次会让首个样本退化为重复版本错误，属已知限制。
 */
function derivePublishVersion(): string {
  return `v1.0.${Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 1000)}`;
}

/** 发布与复制：publish（自增版本）→ 重复版本拒绝样本 → released_workflows → list_publish_workflow → copy（副本随即删除）→ delete_strategy → workflow_detail。 */
export async function probeVersion(context: RunContext): Promise<void> {
  const version = derivePublishVersion();
  const publishBody = { workflow_id: context.workflowId, space_id: context.spaceId, has_collaborator: false };
  await probe(
    context,
    post(
      "workflow_api.publish",
      GROUP_VERSION,
      "发布版本（has_collaborator 必填 + workflow_version 自增）",
      "/api/workflow_api/publish",
      {
        body: { ...publishBody, workflow_version: version },
        note: `workflow_version=${version}`,
      },
    ),
  );
  await probe(
    context,
    post(
      "workflow_api.publish.default_version",
      GROUP_VERSION,
      "不带 workflow_version 发布（版本已存在时的形态）",
      "/api/workflow_api/publish",
      {
        body: publishBody,
        expectation: "error-shape",
      },
    ),
  );
  await probe(
    context,
    post(
      "workflow_api.publish.stale_version",
      GROUP_VERSION,
      "重复版本号发布（版本必须自增）",
      "/api/workflow_api/publish",
      {
        body: { ...publishBody, workflow_version: version },
        expectation: "error-shape",
      },
    ),
  );
  await probe(
    context,
    post(
      "workflow_api.released_workflows",
      GROUP_VERSION,
      "已发布 workflow 列表",
      "/api/workflow_api/released_workflows",
      {
        body: { space_id: context.spaceId, page: 1, size: 10 },
      },
    ),
  );
  await probe(
    context,
    post(
      "workflow_api.list_publish_workflow",
      GROUP_VERSION,
      "发布记录（size 必填）",
      "/api/workflow_api/list_publish_workflow",
      {
        body: { space_id: context.spaceId, size: 10 },
      },
    ),
  );
  const copyRun = await probe(
    context,
    post("workflow_api.copy", GROUP_VERSION, "复制 workflow（副本在同一次运行内删除）", "/api/workflow_api/copy", {
      body: { workflow_id: context.workflowId, space_id: context.spaceId },
    }),
  );
  const copyId = asString(pick(copyRun.response?.json, ["data", "workflow_id"]));
  if (copyId) await deleteWorkflow(context, copyId, "workflow_api.copy.cleanup_delete");
  await probe(
    context,
    post("workflow_api.delete_strategy", GROUP_VERSION, "删除引用策略", "/api/workflow_api/delete_strategy", {
      body: { workflow_id: context.workflowId, space_id: context.spaceId },
    }),
  );
  await probe(
    context,
    post("workflow_api.workflow_detail", GROUP_VERSION, "workflow 详情（批量）", "/api/workflow_api/workflow_detail", {
      body: { space_id: context.spaceId, workflow_ids: [context.workflowId] },
    }),
  );
}
