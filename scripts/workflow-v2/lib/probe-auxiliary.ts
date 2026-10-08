/**
 * 上游契约探针的辅助套件：节点面板、运行 trace、认证形态、资源清理与重登核销。
 *
 * 与入口 `../upstream-contract-probe.ts` 及同级探针模块共同工作；模块按「采集基建 / 引导资源 /
 * 主链路套件 / 辅助套件 / 编排」拆分，为的是守住单文件规模。
 */

import { recordSkip } from "./probe-bootstrap";
import { asString, pick, post, probe, type RunContext, sendRequest } from "./probe-core";
import {
  GROUP_AUTH,
  GROUP_CLEANUP,
  GROUP_PANEL,
  GROUP_TRACE,
  PROBE_WORKFLOW_NAME,
  WORKFLOW_ICON_URI,
} from "./probe-shared";

/** 节点面板：模板列表、面板搜索、图片签名（v2 需按白名单过滤前两者的响应）。 */
export async function probeNodePanel(context: RunContext): Promise<void> {
  await probe(
    context,
    post(
      "workflow_api.node_template_list",
      GROUP_PANEL,
      "节点模板列表（不传 need_types 返回全部）",
      "/api/workflow_api/node_template_list",
      { body: {} },
    ),
  );
  await probe(
    context,
    post("workflow_api.node_panel_search", GROUP_PANEL, "节点面板搜索", "/api/workflow_api/node_panel_search", {
      body: {
        search_type: 0,
        space_id: context.spaceId,
        search_key: "",
        page_or_cursor: "",
        page_size: 20,
        exclude_workflow_id: context.workflowId,
      },
    }),
  );
  await probe(
    context,
    post(
      "workflow_api.sign_image_url",
      GROUP_PANEL,
      "图片签名（返回签名 URL，输出已脱敏）",
      "/api/workflow_api/sign_image_url",
      {
        body: { uri: WORKFLOW_ICON_URI },
      },
    ),
  );
}

/** 运行 trace：list_spans 与 get_trace（§9.1 第 7 条取数通道核销）。 */
export async function probeTrace(context: RunContext): Promise<void> {
  const nowMs = Date.now();
  await probe(
    context,
    post(
      "workflow_api.list_spans",
      GROUP_TRACE,
      "运行 span 列表（start_at/end_at 为毫秒）",
      "/api/workflow_api/list_spans",
      {
        body: {
          start_at: nowMs - 3_600_000,
          end_at: nowMs + 3_600_000,
          workflow_id: context.workflowId,
          limit: 20,
          desc_by_start_time: true,
        },
      },
    ),
  );
  await probe(
    context,
    post("workflow_api.get_trace", GROUP_TRACE, "trace 详情（POST + query）", "/api/workflow_api/get_trace", {
      query: {
        workflow_id: context.workflowId,
        ...(context.executeId ? { execute_id: context.executeId } : {}),
        start_at: String(nowMs - 3_600_000),
        end_at: String(nowMs + 3_600_000),
      },
      body: {},
    }),
  );
}

/** 认证与参数校验形态（§9.1 第 1、4 条：BFF 需据此刻画错误分支）。 */
export async function probeAuthShape(context: RunContext): Promise<void> {
  const canvasBody = { workflow_id: context.workflowId, space_id: context.spaceId };
  await probe(
    context,
    post("auth.missing_session", GROUP_AUTH, "缺少 Cookie", "/api/workflow_api/canvas", {
      body: canvasBody,
      sessionKey: null,
      expectation: "error-shape",
    }),
  );
  await probe(
    context,
    post("auth.invalid_session", GROUP_AUTH, "无效 session_key", "/api/workflow_api/canvas", {
      body: canvasBody,
      sessionKey: "probe-invalid-session-key",
      expectation: "error-shape",
    }),
  );
  await probe(
    context,
    post(
      "workflow_api.workflow_list.missing_space",
      GROUP_AUTH,
      "缺必填参数（不带 space_id）",
      "/api/workflow_api/workflow_list",
      {
        body: { page: 1, size: 10 },
        expectation: "error-shape",
      },
    ),
  );
}

/**
 * 清理组：`delete` 需要一个真实目标，因此先建一次性 workflow 再删它；`batch_delete` 同理另建一个。
 * 两个一次性资源都在本次运行内删除，不触碰既有数据。
 */
export async function probeCleanup(context: RunContext): Promise<void> {
  const tempId = await createTemporaryWorkflow(context, `${PROBE_WORKFLOW_NAME}-tmp-${Date.now()}`);
  if (tempId) {
    await deleteWorkflow(context, tempId, "workflow_api.delete");
  } else {
    recordSkip(
      context,
      "workflow_api.delete",
      GROUP_CLEANUP,
      "删除 workflow",
      "一次性 workflow 未创建成功，跳过删除探测（无可用目标）",
    );
  }

  const batchId = await createTemporaryWorkflow(context, `${PROBE_WORKFLOW_NAME}-tmp-batch-${Date.now()}`);
  if (!batchId) return;
  await probe(
    context,
    post("workflow_api.batch_delete", GROUP_CLEANUP, "批量删除", "/api/workflow_api/batch_delete", {
      body: { workflow_id_list: [batchId], space_id: context.spaceId },
    }),
  );
}

/** 建一次性 workflow（清理组专用），返回其 id。 */
async function createTemporaryWorkflow(context: RunContext, name: string): Promise<string | null> {
  const run = await probe(
    context,
    post(
      "workflow_api.create.temp",
      GROUP_CLEANUP,
      "创建一次性 workflow（删除类探测的目标）",
      "/api/workflow_api/create",
      {
        body: {
          name,
          desc: "workflow-v2 contract probe (temporary)",
          icon_uri: WORKFLOW_ICON_URI,
          space_id: context.spaceId,
          project_id: context.appId,
        },
      },
    ),
  );
  return asString(pick(run.response?.json, ["data", "workflow_id"]));
}

/** 删除单个 workflow；调用方必须保证目标资源由本次运行创建。 */
export async function deleteWorkflow(context: RunContext, workflowId: string, id: string): Promise<void> {
  await probe(
    context,
    post(id, GROUP_CLEANUP, "删除 workflow", "/api/workflow_api/delete", {
      body: { workflow_id: workflowId, space_id: context.spaceId },
    }),
  );
}

/**
 * 核销「平台账号并发登录/单会话限制」（§9.1 第 3 条）：再登一次后用**旧**会话调 canvas。
 * 若该探测返回成功，说明当前上游允许多会话并存，workflow-v2 的单飞重登假设需要复核。
 */
export async function probeReloginShape(context: RunContext, email: string, password: string): Promise<void> {
  const previousKey = context.sessionKey;
  const relogin = await sendRequest(
    { method: "POST", path: "/api/passport/web/email/login/", body: { email, password }, sessionKey: null },
    context.baseUrl,
  );
  const freshKey = relogin.setCookieTokens[0] ?? null;
  if (!freshKey) return;
  await probe(
    context,
    post(
      "auth.relogin_invalidates_old_session",
      GROUP_AUTH,
      "重新登录后旧 session_key 是否失效",
      "/api/workflow_api/canvas",
      {
        body: { workflow_id: context.workflowId, space_id: context.spaceId },
        sessionKey: previousKey,
        expectation: "error-shape",
        note: "预期失败样本；若变为成功，说明上游允许多会话并存，单飞重登假设需复核",
      },
    ),
  );
  context.sessionKey = freshKey;
}
