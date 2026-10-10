// pages/list/workflow-api-model.ts
// 「调用接口」弹窗的纯逻辑：调用地址拼装与调用示例文本。
//
// 抽成无 UI 依赖的纯函数是为了可断言（示例文本的每一段都是用户直接复制去用的，拼错一个字就会让对方调试半天），
// 组件只负责渲染与复制反馈。
//
// 口径（与后端 `POST /api/workflow-v2/workflows/:id/run` 逐条对应）：
// - 地址里的 `:id` 是**控制台本地主键**（卡片 id），不是上游 workflow ID——调用方只需要看得懂控制台的标识；
// - 凭据是控制台 API Key（`rcs_*`），放 `Authorization: Bearer`；示例里只出现占位符，绝不出现真实密钥；
// - 请求体字段是 `parameters`（JSON 对象或它的 JSON 字符串）、`isAsync`（默认 false）、`ext.user_id`（可选）。

/** 示例里的密钥占位符：写成明显的假值，避免用户误以为是可用的密钥。 */
export const API_KEY_PLACEHOLDER = "rcs_xxxxxxxx";

/** 对外触发端点的路径（`:id` 为本地主键）；方法固定 POST。 */
export function buildRunEndpoint(workflowId: string): { readonly method: "POST"; readonly path: string } {
  return { method: "POST", path: `/api/workflow-v2/workflows/${workflowId}/run` };
}

/**
 * 调用地址（控制台同源）。
 *
 * `origin` 由调用方传入（组件读 `window.location.origin`）：本函数保持纯粹，用例不必摆好全局位置对象。
 */
export function buildRunUrl(origin: string, workflowId: string): string {
  const { path } = buildRunEndpoint(workflowId);
  return `${origin.replace(/\/+$/, "")}${path}`;
}

/** 示例里的 `parameters`：取一个最小可用对象（用户按自己的入参替换）。 */
const EXAMPLE_PARAMETERS = '{"input":"hello"}';

/**
 * curl 调用示例。
 *
 * 同步与异步各一条：它们的差别只有请求体的 `isAsync`，但异步不会返回结果（要回上游调试页看），示例里把这个
 * 差别显式写出来，用户才不会以为响应里丢了 `data`。
 */
export function buildCurlExample(input: {
  readonly url: string;
  readonly isAsync: boolean;
  /** 覆盖示例入参（默认一个最小对象）。 */
  readonly parameters?: string;
}): string {
  const body = `{"parameters":${input.parameters ?? EXAMPLE_PARAMETERS},"isAsync":${String(input.isAsync)}}`;
  return [
    `curl -X POST '${input.url}'`,
    `  -H 'Authorization: Bearer ${API_KEY_PLACEHOLDER}'`,
    "  -H 'Content-Type: application/json'",
    `  -d '${body}'`,
  ].join(" \\\n");
}
