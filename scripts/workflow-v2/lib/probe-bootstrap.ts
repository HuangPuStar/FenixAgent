/**
 * 上游契约探针的引导资源准备：探针 App / workflow 的复用校验与创建，以及默认 schema 修复。
 *
 * 与入口 `../upstream-contract-probe.ts` 及同级探针模块共同工作；模块按「采集基建 / 引导资源 /
 * 主链路套件 / 辅助套件 / 编排」拆分，为的是守住单文件规模。
 */

import { asString, pick, post, probe, type RunContext, redactValue, sendRequest } from "./probe-core";
import { APP_ICON_URI, GROUP_BOOTSTRAP, PROBE_APP_NAME, PROBE_WORKFLOW_NAME, WORKFLOW_ICON_URI } from "./probe-shared";

/** 登记一条「未发请求」的结果（跳过等），保持输出结构与真实探测一致。 */
export function recordSkip(context: RunContext, id: string, group: string, title: string, note: string): void {
  context.records.push({
    id,
    group,
    title,
    method: "POST",
    path: "/api/workflow_api/create",
    request: "<skipped>",
    httpStatus: null,
    businessCode: null,
    msg: null,
    outcome: "skipped",
    durationMs: 0,
    shape: null,
    note,
  });
}

/**
 * 准备探针资源：优先复用台账中的 App/workflow（上游无「按空间列 App」接口，只能靠台账定位），
 * 复用失败或台账缺失时才创建。`draftbot/create` 只在创建路径上真正执行，复用路径记为 skipped。
 */
export async function resolveProbeResources(context: RunContext, reusable: boolean): Promise<void> {
  if (reusable) {
    const listQuery = {
      space_id: context.spaceId,
      project_id: context.appId,
      name: PROBE_WORKFLOW_NAME,
      page: 1,
      size: 20,
    };
    const verify = await sendRequest(
      { method: "POST", path: "/api/workflow_api/workflow_list", body: listQuery, sessionKey: context.sessionKey },
      context.baseUrl,
    );
    const list = pick(verify.json, ["data", "workflow_list"]);
    const reused =
      Array.isArray(list) && list.some((item) => asString(pick(item, ["workflow_id"])) === context.workflowId);
    if (reused) {
      recordSkip(
        context,
        "workflow_api.create",
        GROUP_BOOTSTRAP,
        "新建 workflow",
        `复用台账中的探针 workflow（project_id=${context.appId}）；要覆盖 create 请删掉 state 文件重跑`,
      );
      await probe(
        context,
        post(
          "playground_api.get_draft_bot_info",
          GROUP_BOOTSTRAP,
          "租户 App 详情（校验复用的探针 App 仍在）",
          "/api/playground_api/draftbot/get_draft_bot_info",
          {
            body: { bot_id: context.appId },
          },
        ),
      );
      return;
    }
    context.records.push({
      id: "workflow_api.create.reuse",
      group: GROUP_BOOTSTRAP,
      title: "复用台账校验",
      method: "POST",
      path: "/api/workflow_api/workflow_list",
      request: redactValue(listQuery),
      httpStatus: verify.httpStatus,
      businessCode: verify.businessCode,
      msg: verify.msg,
      outcome: "fail",
      durationMs: 0,
      shape: null,
      note: `台账中的 workflow（${context.workflowId}）未在 project_id=${context.appId} 下命中，改为重新创建探针资源`,
    });
    context.appId = "";
    context.workflowId = "";
  }

  const appRun = await probe(
    context,
    post("draftbot.create", GROUP_BOOTSTRAP, "建租户 App（organization ↔ 上游应用 的载体）", "/api/draftbot/create", {
      body: {
        space_id: context.spaceId,
        name: PROBE_APP_NAME,
        description: "workflow-v2 contract probe",
        icon_uri: APP_ICON_URI,
      },
    }),
  );
  context.appId = asString(pick(appRun.response?.json, ["data", "bot_id"])) ?? "";
  if (!context.appId) return;

  const workflowRun = await probe(
    context,
    post("workflow_api.create", GROUP_BOOTSTRAP, "新建 workflow（挂载在租户 App 下）", "/api/workflow_api/create", {
      body: {
        name: PROBE_WORKFLOW_NAME,
        desc: "workflow-v2 contract probe",
        icon_uri: WORKFLOW_ICON_URI,
        space_id: context.spaceId,
        project_id: context.appId,
      },
    }),
  );
  context.workflowId = asString(pick(workflowRun.response?.json, ["data", "workflow_id"])) ?? "";
}

/**
 * 修复上游 `create` 生成的默认 schema：End 节点入参引用默认带空 `blockID`/`name`
 * （`{"source":"block-output","blockID":"","name":""}`），该形态会让 `node_type` / `validate_tree`
 * / `test_run` 直接失败（`invalid BlockInputReference`）。探针把它指向 Start 的首个输出以获得
 * 成功样本 —— 这是对上游默认值缺陷的规避，不是契约本身的要求。
 */
export function repairDefaultSchema(schemaText: string): { schema: string; repaired: boolean; detail: string } {
  const parsed: unknown = JSON.parse(schemaText);
  const nodes = pick(parsed, ["nodes"]);
  if (!Array.isArray(nodes)) return { schema: schemaText, repaired: false, detail: "schema 无 nodes 数组，原样保存" };
  const startNode = nodes.find((node) => pick(node, ["type"]) === "1");
  const startId = asString(pick(startNode, ["id"]));
  const startOutputs = pick(startNode, ["data", "outputs"]);
  const startOutputName = Array.isArray(startOutputs) ? asString(pick(startOutputs[0], ["name"])) : null;
  let repaired = false;
  for (const node of nodes) {
    if (pick(node, ["type"]) !== "2") continue;
    const parameters = pick(node, ["data", "inputs", "inputParameters"]);
    if (!Array.isArray(parameters)) continue;
    for (const parameter of parameters) {
      const value = pick(parameter, ["input", "value"]);
      const content = pick(value, ["content"]);
      if (pick(value, ["type"]) !== "ref" || pick(content, ["source"]) !== "block-output") continue;
      if (asString(pick(content, ["blockID"])) && asString(pick(content, ["name"]))) continue;
      if (!startId || !startOutputName) continue;
      (content as Record<string, unknown>).blockID = startId;
      (content as Record<string, unknown>).name = startOutputName;
      repaired = true;
    }
  }
  return {
    schema: repaired ? JSON.stringify(parsed) : schemaText,
    repaired,
    detail: repaired ? `End 节点引用已指向 Start(${startId}).${startOutputName}` : "默认 schema 无需修复",
  };
}
